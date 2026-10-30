'use strict';
/* Estúdio de Narração · A Liga
   Teleprompter sincronizado com cada vídeo + gravação do microfone + exportação em MP3.
   O áudio gravado começa exatamente no quadro 0 do vídeo e termina na duração exata dele. */

const SR = 48000;                       // taxa de gravação e de exportação (padrão de vídeo)
const ATRASO_MP3 = 1105;                // atraso do codificador+decodificador MP3, compensado na exportação
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
function h(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(f));
  return e;
}

/* ------------------------------------------------------------------ configuração */
const PADRAO = { eco: false, ruido: true, agc: false, dev: '', somVideo: false, fonte: 56, espelho: false,
                 syncMs: 0, alvoLufs: -16, hpf: true, nr: true, lead: 0.3 };
let cfg = { ...PADRAO };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('estudio-cfg') || '{}')); } catch (e) {}
const salvarCfg = () => { try { localStorage.setItem('estudio-cfg', JSON.stringify(cfg)); } catch (e) {} };
const aviso = (t, ms = 2800) => { const a = $('#aviso'); a.textContent = t; a.classList.add('on'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('on'), ms); };

/* ------------------------------------------------------------------ armazenamento dos takes */
const BD = {
  db: null, mem: [], seq: 1,
  async abrir() {
    try {
      await new Promise((res, rej) => {
        const r = indexedDB.open('estudio-narracao-aliga', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('takes', { keyPath: 'id', autoIncrement: true }).createIndex('parte', 'parte');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    } catch (e) { this.db = null; console.warn('IndexedDB indisponível, takes só nesta sessão', e); }
  },
  _req(modo, fn) { return new Promise((res, rej) => { const q = fn(this.db.transaction('takes', modo).objectStore('takes')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async add(t) { if (!this.db) { t.id = this.seq++; this.mem.push(t); return t.id; } return this._req('readwrite', s => s.add(t)); },
  async lista(parte) { if (!this.db) return this.mem.filter(t => t.parte === parte); return this._req('readonly', s => s.index('parte').getAll(parte)); },
  async get(id) { if (!this.db) return this.mem.find(t => t.id === id); return this._req('readonly', s => s.get(id)); },
  async del(id) { if (!this.db) { this.mem = this.mem.filter(t => t.id !== id); return; } return this._req('readwrite', s => s.delete(id)); },
};
const escolhido = parte => { try { return +localStorage.getItem('estudio-take-' + parte) || 0; } catch (e) { return 0; } };
const escolher = (parte, id) => { try { localStorage.setItem('estudio-take-' + parte, id); } catch (e) {} };

/* ------------------------------------------------------------------ microfone e gravador */
const CODIGO_WORKLET = `
class Gravador extends AudioWorkletProcessor {
  constructor(){ super(); this.on=false; this.buf=[]; this.n=0; this.primeiro=null;
    this.port.onmessage=e=>{ if(e.data==='start'){this.on=true;this.primeiro=null;this.buf=[];this.n=0;}
      else if(e.data==='stop'){this.on=false;this.flush();this.port.postMessage({fim:true});} }; }
  process(inputs){ const c=inputs[0]&&inputs[0][0];
    if(c&&this.on){ if(this.primeiro===null){this.primeiro=currentTime;this.port.postMessage({primeiro:currentTime});}
      this.buf.push(new Float32Array(c)); this.n+=c.length; if(this.buf.length>=32) this.flush(); }
    return true; }
  flush(){ if(!this.buf.length) return; const o=new Float32Array(this.n); let p=0; for(const b of this.buf){o.set(b,p);p+=b.length;}
    this.port.postMessage({pcm:o.buffer},[o.buffer]); this.buf=[]; this.n=0; }
}
registerProcessor('gravador', Gravador);`;

const Mic = {
  ctx: null, stream: null, analyser: null, ligado: false, gravando: false, partes: [], tCap: null, aguardandoFim: null,
  async ligar() {
    await this.desligar();
    const audio = { channelCount: 1, echoCancellation: cfg.eco, noiseSuppression: cfg.ruido, autoGainControl: cfg.agc };
    if (cfg.dev) audio.deviceId = { exact: cfg.dev };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    const mudo = this.ctx.createGain(); mudo.gain.value = 0; mudo.connect(this.ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.no = new AudioWorkletNode(this.ctx, 'gravador', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      this.no.port.onmessage = e => {
        if (e.data.primeiro !== undefined) this.tCap = e.data.primeiro;
        if (e.data.pcm) this.partes.push(new Float32Array(e.data.pcm));
        if (e.data.fim && this.aguardandoFim) this.aguardandoFim();
      };
      src.connect(this.no); this.no.connect(mudo);
    } catch (err) {                       // plano B para navegadores sem AudioWorklet
      console.warn('AudioWorklet indisponível, usando ScriptProcessor', err);
      const sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = e => {
        if (!this.gravando) return;
        if (this.tCap === null) this.tCap = this.ctx.currentTime - 4096 / SR;
        this.partes.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(sp); sp.connect(mudo); this.sp = sp; this.no = null;
    }
    this.ligado = true;
    this.estado();
    const info = this.stream.getAudioTracks()[0];
    return info;
  },
  async desligar() {
    this.ligado = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) { try { await this.ctx.close(); } catch (e) {} }
    this.ctx = this.stream = this.analyser = this.no = this.sp = null;
    this.estado();
  },
  comecar() { this.partes = []; this.tCap = null; this.gravando = true; if (this.no) this.no.port.postMessage('start'); },
  async terminar() {
    this.gravando = false;
    if (this.no) { await new Promise(r => { this.aguardandoFim = r; this.no.port.postMessage('stop'); setTimeout(r, 1500); }); }
    const n = this.partes.reduce((a, b) => a + b.length, 0), pcm = new Float32Array(n); let p = 0;
    for (const b of this.partes) { pcm.set(b, p); p += b.length; }
    this.partes = [];
    return { pcm, tCap: this.tCap };
  },
  nivel() {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(d);
    let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    return m;
  },
  estado() {
    const e = $('#micEstado'); if (!e) return;
    e.textContent = this.ligado ? 'Microfone ligado' : 'Microfone desligado';
    e.classList.toggle('on', this.ligado);
  },
};
(function medidor() {
  const f = () => {
    const n = Mic.nivel(), db = 20 * Math.log10(n + 1e-6), pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    $$('.medidor i').forEach(i => i.style.width = pct + '%');
    requestAnimationFrame(f);
  }; f();
})();

/* ------------------------------------------------------------------ processamento de áudio */
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; y[i] = v; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; }
  return y;
}
function passaAlta(x, f = 80, q = 0.7071) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
  return biquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - a) / a0);
}
function lufs(x) {                      // ITU-R BS.1770 (canal único, 48 kHz)
  let y = biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585);
  y = biquad(y, 1, -2, 1, -1.99004745483398, 0.99007225036621);
  const bloco = Math.round(0.4 * SR), passo = Math.round(0.1 * SR), z = [];
  for (let i = 0; i + bloco <= y.length; i += passo) { let s = 0; for (let k = i; k < i + bloco; k++) s += y[k] * y[k]; z.push(s / bloco); }
  const L = v => -0.691 + 10 * Math.log10(v);
  const a = z.filter(v => L(v) > -70); if (!a.length) return -70;
  const rel = L(a.reduce((p, q) => p + q, 0) / a.length) - 10;
  const b = a.filter(v => L(v) > rel); if (!b.length) return -70;
  return L(b.reduce((p, q) => p + q, 0) / b.length);
}
function reduzirRuido(x) {              // expansor suave: abaixa só o chiado entre as frases
  const q = Math.round(0.02 * SR), n = Math.floor(x.length / q), rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * q; k < (i + 1) * q; k++) s += x[k] * x[k]; rms[i] = 10 * Math.log10(s / q + 1e-12); }
  const ord = [...rms].sort((a, b) => a - b), piso = ord[Math.floor(n * 0.1)], limiar = piso + 9;
  const alvo = new Float32Array(n).map((_, i) => rms[i] < limiar ? Math.pow(10, -9 / 20) : 1);
  const y = new Float32Array(x.length); let g = 1;
  const ataque = 1 - Math.exp(-1 / (0.006 * SR)), soltar = 1 - Math.exp(-1 / (0.18 * SR));
  for (let i = 0; i < x.length; i++) { const t = alvo[Math.min(n - 1, Math.floor(i / q))]; g += (t - g) * (t > g ? ataque : soltar * 1.8); y[i] = x[i] * g; }
  return y;
}
function limitar(x, teto = Math.pow(10, -1.5 / 20)) {
  const N = 96, len = x.length, need = new Float32Array(len);
  for (let i = 0; i < len; i++) need[i] = Math.min(1, teto / (Math.abs(x[i]) + 1e-9));
  const gmin = new Float32Array(len), dq = [];                  // mínimo deslizante à frente (janela N)
  for (let i = len - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i); while (dq[0] > i + N) dq.shift();
    gmin[i] = need[dq[0]];
  }
  const y = new Float32Array(len); let acc = 0;
  for (let i = 0; i < len; i++) { acc += gmin[i]; if (i > N) acc -= gmin[i - N - 1]; const g = acc / Math.min(i + 1, N + 1); y[i] = x[i] * g; }
  return y;
}
function processar(pcm, durSec, op) {
  const total = Math.round(durSec * SR);
  let x = new Float32Array(total);
  const desl = Math.round((op.deslMs || 0) / 1000 * SR);
  for (let i = 0; i < total; i++) { const j = i - desl; if (j >= 0 && j < pcm.length) x[i] = pcm[j]; }
  if (op.hpf) x = passaAlta(x);
  if (op.nr) x = reduzirRuido(x);
  const antes = lufs(x);
  if (op.norm && antes > -69) {
    const g = Math.pow(10, (op.alvo - antes) / 20); for (let i = 0; i < total; i++) x[i] *= g;
    x = limitar(x);
  } else x = limitar(x, 0.98);
  const fade = Math.round(0.015 * SR); for (let i = 0; i < fade; i++) { const f = i / fade; x[i] *= f; x[total - 1 - i] *= f; }
  let pico = 0; for (let i = 0; i < total; i++) pico = Math.max(pico, Math.abs(x[i]));
  return { x, lufsAntes: antes, lufsDepois: lufs(x), picoDb: 20 * Math.log10(pico + 1e-9) };
}
function paraInt16(x, atraso = 0) {
  const y = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) { const v = x[i + atraso] || 0; y[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }
  return y;
}
function codificarMp3(x, kbps = 192) {
  const pcm = paraInt16(x, ATRASO_MP3);           // adianta o sinal pra compensar o atraso do MP3
  const enc = new lamejs.Mp3Encoder(1, SR, kbps), partes = [], T = 1152;
  for (let i = 0; i < pcm.length; i += T) { const b = enc.encodeBuffer(pcm.subarray(i, i + T)); if (b.length) partes.push(new Uint8Array(b)); }
  const f = enc.flush(); if (f.length) partes.push(new Uint8Array(f));
  return new Blob(partes, { type: 'audio/mpeg' });
}
function codificarWav(x) {
  const pcm = paraInt16(x), n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const txt = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); txt(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, 'data'); v.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
const int16ParaFloat = buf => { const i = new Int16Array(buf), f = new Float32Array(i.length); for (let k = 0; k < i.length; k++) f[k] = i[k] / 32768; return f; };
function baixar(blob, nome) {
  const a = h('a', { href: URL.createObjectURL(blob), download: nome }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function duracaoVideo(parte) {
  return new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res(v.duration); v.onerror = () => res(parte.duracao); v.src = parte.video; });
}

/* ------------------------------------------------------------------ navegação */
const Estado = { tela: 'painel', parte: null };
function ir(tela, id) {
  pararTudo();
  Estado.tela = tela; Estado.parte = id || null;
  document.body.classList.remove('foco');
  tela === 'estudio' ? telaEstudio(PARTES.find(p => p.id === id)) : telaPainel();
}
$('#btnPainel').addEventListener('click', () => ir('painel'));
function pararTudo() { Estudio.sair && Estudio.sair(); }

/* ------------------------------------------------------------------ painel */
async function telaPainel() {
  const raiz = $('#tela'); raiz.innerHTML = '';
  const pg = h('div', { class: 'pagina' });
  pg.append(
    h('h1', {}, 'Narração das aulas'),
    h('p', { class: 'sub' }, 'Cada aula tem o roteiro na tela, acompanhando o vídeo. Leia no ritmo do destaque azul, e o aplicativo grava a sua voz já alinhada com o vídeo. No fim, exporte o MP3 pronto para colocar na aula.'),
    h('div', { class: 'passos' },
      h('div', { class: 'passo' }, h('b', {}, '1'), h('span', {}, 'Ligue o microfone e confira o medidor.')),
      h('div', { class: 'passo' }, h('b', {}, '2'), h('span', {}, 'Grave cada aula lendo o texto. Pode repetir quantas vezes quiser.')),
      h('div', { class: 'passo' }, h('b', {}, '3'), h('span', {}, 'Escolha o melhor take e baixe o MP3.'))));

  // microfone
  const sel = h('select', { id: 'selMic' }, h('option', { value: '' }, 'Microfone padrão do computador'));
  const bloco = h('div', { class: 'cartao mic-bloco' },
    h('div', {},
      h('h2', {}, 'Microfone'),
      h('label', { class: 'campo', for: 'selMic' }, 'Dispositivo de entrada'), sel,
      h('div', { class: 'linha-btn' },
        h('button', { class: 'btn prim', id: 'btnLigar', onclick: ligarMic }, 'Ligar microfone'),
        h('button', { class: 'btn', id: 'btnTeste', onclick: testeMic }, 'Gravar 5 s de teste')),
      h('p', { class: 'ajuda' }, 'Use fone de ouvido se quiser ouvir o som do vídeo enquanto grava, assim o microfone não capta o vídeo. Fale a uns 20 cm do microfone.')),
    h('div', {},
      h('h2', {}, 'Qualidade da captação'),
      chk('ruido', 'Reduzir ruído do ambiente (navegador)', 'Ajuda contra ventilador e ar-condicionado.'),
      chk('eco', 'Cancelar eco', 'Só ligue se estiver sem fone de ouvido.'),
      chk('agc', 'Ajuste automático de volume', 'Deixe desligado: a exportação já nivela o volume.')));
  pg.append(h('div', { class: 'grade' }, bloco));
  sel.value = cfg.dev; sel.addEventListener('change', () => { cfg.dev = sel.value; salvarCfg(); if (Mic.ligado) ligarMic(); });
  listarMics(sel);

  // aulas
  const lista = h('div', { class: 'partes' });
  for (const p of PARTES) {
    const takes = await BD.lista(p.id), sel_ = escolhido(p.id);
    const nPal = p.segmentos.filter(s => s.tipo === 'fala').reduce((a, s) => a + s.palavras.length, 0);
    const video = h('video', { src: p.video + '#t=4', preload: 'metadata', muted: '', playsinline: '' });
    lista.append(h('article', { class: 'cartao parte' },
      video,
      h('h3', {}, `${p.numero}. ${p.titulo}`),
      h('div', { class: 'meta' }, h('span', {}, `Duração ${fmt(p.duracao)}`), h('span', {}, `${nPal} palavras`),
        takes.length ? h('span', { class: 'selo ok' }, `${takes.length} take${takes.length > 1 ? 's' : ''}`) : h('span', { class: 'selo' }, 'Ainda sem gravação')),
      h('div', { class: 'linha-btn', style: 'margin-top:auto' },
        h('button', { class: 'btn prim', onclick: () => ir('estudio', p.id) }, takes.length ? 'Abrir aula' : 'Gravar esta aula'),
        h('button', { class: 'btn', disabled: takes.length ? null : '', onclick: () => dialogoExportar(p) }, 'Exportar MP3'))));
  }
  pg.append(h('h2', { style: 'margin-top:34px' }, 'Aulas'), lista,
    h('div', { class: 'linha-btn' }, h('button', { class: 'btn', onclick: exportarTodos }, 'Exportar as 3 aulas')));
  raiz.append(pg);
  Mic.estado();
}
function chk(chave, titulo, dica) {
  const i = h('input', { type: 'checkbox', id: 'c_' + chave });
  i.checked = !!cfg[chave];
  i.addEventListener('change', () => { cfg[chave] = i.checked; salvarCfg(); if (Mic.ligado) aviso('Clique em “Ligar microfone” de novo para aplicar.'); });
  return h('label', { class: 'chk' }, i, h('span', {}, titulo, h('small', {}, dica)));
}
async function listarMics(sel) {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    d.filter(x => x.kind === 'audioinput').forEach(x => { if (x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications') sel.append(h('option', { value: x.deviceId }, x.label || 'Microfone')); });
    sel.value = cfg.dev;
  } catch (e) {}
}
async function ligarMic() {
  try {
    await Mic.ligar();
    const sel = $('#selMic'); if (sel && sel.options.length <= 1) listarMics(sel);
    aviso('Microfone ligado. Fale para ver o medidor mexer.');
  } catch (e) {
    aviso(e.name === 'NotAllowedError' ? 'O navegador bloqueou o microfone. Clique no cadeado da barra de endereço e permita.' : 'Não consegui abrir o microfone: ' + e.message, 6000);
  }
}
async function testeMic() {
  if (!Mic.ligado) await ligarMic(); if (!Mic.ligado) return;
  aviso('Gravando 5 segundos… fale normalmente.', 5200);
  Mic.comecar(); await sleep(5000); const r = await Mic.terminar();
  const x = r.pcm, pico = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (pico < 0.003) { aviso('Quase não captei som. Confira se o microfone certo está selecionado.', 6000); return; }
  const b = Mic.ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0);
  const s = Mic.ctx.createBufferSource(); s.buffer = b; s.connect(Mic.ctx.destination); s.start();
  aviso(`Ouça o teste. Pico: ${(20 * Math.log10(pico)).toFixed(0)} dB ${pico > 0.95 ? '(alto demais, afaste-se um pouco)' : pico < 0.05 ? '(baixo, aproxime-se um pouco)' : '(bom)'}`, 6500);
}

/* ------------------------------------------------------------------ estúdio (teleprompter + gravação) */
const Estudio = { parte: null, video: null, raf: 0, palavras: [], pausas: [], idx: -2, estado: 'parado', tPlay: 0, take: null };

async function telaEstudio(parte) {
  const E = Estudio; E.parte = parte; E.idx = -2; E.estado = 'parado';
  const raiz = $('#tela'); raiz.innerHTML = '';
  const dur = parte.duracao;

  const video = h('video', { src: parte.video, preload: 'auto', playsinline: '' }); video.muted = !cfg.somVideo;
  E.video = video;
  const prog = h('div', { class: 'prog' }), barra = h('div', { class: 'barra', title: 'Clique para ir a outro ponto (só no ensaio)' }, prog);
  parte.segmentos.filter(s => s.tipo === 'pausa').forEach(s => barra.append(h('div', { class: 'pausa', style: `left:${s.t0 / dur * 100}%;width:${(s.t1 - s.t0) / dur * 100}%`, title: s.rotulo })));
  barra.addEventListener('click', ev => { if (E.estado !== 'parado' && E.estado !== 'ensaio') return; const r = barra.getBoundingClientRect(); video.currentTime = (ev.clientX - r.left) / r.width * video.duration; });
  const tCur = h('span', {}, '0:00'), tTot = h('span', {}, fmt(dur));

  const btnGravar = h('button', { class: 'btn rec', id: 'btnGravar', onclick: () => E.estado === 'gravando' || E.estado === 'contagem' ? parar() : gravar() }, '● Gravar');
  const btnEnsaio = h('button', { class: 'btn', id: 'btnEnsaio', onclick: ensaiar }, '▶ Ensaiar');
  const btnZero = h('button', { class: 'btn fant', onclick: () => { if (E.estado === 'parado' || E.estado === 'ensaio') { video.pause(); video.currentTime = 0; E.estado = 'parado'; atualizarBotoes(); } } }, '⏮ Início');
  const sFonte = h('input', { type: 'range', min: 32, max: 110, value: cfg.fonte }); sFonte.addEventListener('input', () => { cfg.fonte = +sFonte.value; salvarCfg(); tele.style.fontSize = cfg.fonte + 'px'; E.idx = -2; });
  const cSom = h('input', { type: 'checkbox' }); cSom.checked = cfg.somVideo; cSom.addEventListener('change', () => { cfg.somVideo = cSom.checked; salvarCfg(); video.muted = !cfg.somVideo; });
  const cEsp = h('input', { type: 'checkbox' }); cEsp.checked = cfg.espelho; cEsp.addEventListener('change', () => { cfg.espelho = cEsp.checked; salvarCfg(); tele.classList.toggle('espelho', cfg.espelho); });
  const takesEl = h('div', { class: 'takes' });

  const lado = h('aside', { class: 'lado' },
    h('button', { class: 'voltar', onclick: () => ir('painel') }, '← Voltar ao painel'),
    h('h2', {}, `${parte.numero}. ${parte.titulo}`),
    h('div', { class: 'player' }, video),
    h('div', {}, barra, h('div', { class: 'tempo' }, tCur, tTot)),
    h('div', { class: 'ctrl' }, btnGravar, btnEnsaio, btnZero),
    h('label', { class: 'faixa' }, 'Letra', sFonte),
    h('label', { class: 'chk', style: 'margin-top:0' }, cSom, h('span', {}, 'Ouvir o som do vídeo', h('small', {}, 'Só com fone de ouvido, senão o microfone capta.'))),
    h('label', { class: 'chk', style: 'margin-top:0' }, cEsp, h('span', {}, 'Espelhar texto', h('small', {}, 'Para teleprompter de vidro.'))),
    h('div', { class: 'linha-btn', style: 'margin:0' },
      h('button', { class: 'btn peq', onclick: () => alternarFoco() }, 'Modo foco'),
      h('button', { class: 'btn peq', onclick: () => dialogoExportar(parte) }, 'Exportar MP3')),
    h('h2', { style: 'font-size:16px;margin-top:6px' }, 'Takes'), takesEl);

  // teleprompter
  const tele = h('div', { class: 'tele' }); tele.style.fontSize = cfg.fonte + 'px'; tele.classList.toggle('espelho', cfg.espelho);
  E.palavras = []; E.pausas = [];
  let frase = null;
  const fecha = () => { frase = null; };
  for (const seg of parte.segmentos) {
    if (seg.tipo === 'pausa') {
      fecha();
      const cont = h('span', { class: 'cont' }, '');
      const el = h('div', { class: 'tele-pausa' }, h('span', {}, '⏸'), h('span', {}, h('b', {}, 'Silêncio'), `${seg.rotulo} · ${Math.round(seg.t1 - seg.t0)} s`), cont);
      tele.append(el); E.pausas.push({ el, cont, t0: seg.t0, t1: seg.t1 });
    } else {
      for (const p of seg.palavras) {
        if (!frase) { frase = h('p', { class: 'frase' }); tele.append(frase); }
        const sp = h('span', { class: 'w' }, p.w); frase.append(sp, ' ');
        E.palavras.push({ el: sp, t: p.t });
        if (/[.!?]["”)]?$/.test(p.w)) fecha();
      }
      fecha();
    }
  }
  const miolo = h('div', { class: 'tele-miolo' }, tele, h('div', { class: 'guia' }));
  const contagem = h('div', { class: 'contagem' }, h('div', {}, h('span', {}, '3'), h('small', {}, 'Respire e comece quando o vídeo começar')));
  const estadoRec = h('div', { class: 'estado-rec' }, h('i'), h('span', {}, 'GRAVANDO'));
  const faixa = h('div', { class: 'faixa-tele' }, h('div', { class: 'grp' }, estadoRec, h('span', { class: 'mic-estado', id: 'faixaDica' }, 'Acompanhe o destaque azul.')), h('div', { class: 'grp' }, h('div', { class: 'medidor' }, h('i'))));
  const mini = h('div', { class: 'miniplayer' });
  const area = h('section', { class: 'tele-area' }, miolo, contagem, faixa, mini);
  raiz.append(h('div', { class: 'estudio' }, lado, area));
  E.ui = { tele, prog, tCur, btnGravar, btnEnsaio, contagem, estadoRec, takesEl, miolo, mini, video, dica: $('#faixaDica') };

  video.addEventListener('ended', () => { if (E.estado === 'gravando') parar(true); else { E.estado = 'parado'; atualizarBotoes(); } });
  document.addEventListener('keydown', teclas);
  const f = () => { loop(); E.raf = requestAnimationFrame(f); }; f();
  await listarTakes();
  atualizarBotoes();
}
Estudio.sair = function () {
  const E = Estudio; if (!E.video) return; cancelAnimationFrame(E.raf); document.removeEventListener('keydown', teclas);
  if (E.video) { E.video.pause(); E.video.removeAttribute('src'); E.video.load(); }
  if (Mic.gravando) Mic.terminar();
  E.video = null; E.estado = 'parado'; E.parte = null; E.ui = null;
};
function teclas(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('#dlg').open) return;
  const E = Estudio;
  if (e.code === 'Space') { e.preventDefault(); (E.estado === 'gravando' || E.estado === 'contagem') ? parar() : (E.estado === 'ensaio' ? pausarEnsaio() : gravar()); }
  else if (e.key === 'Escape' && document.body.classList.contains('foco')) alternarFoco();
  else if (e.key === '+' || e.key === '=') { cfg.fonte = Math.min(110, cfg.fonte + 4); salvarCfg(); E.ui.tele.style.fontSize = cfg.fonte + 'px'; E.idx = -2; }
  else if (e.key === '-') { cfg.fonte = Math.max(32, cfg.fonte - 4); salvarCfg(); E.ui.tele.style.fontSize = cfg.fonte + 'px'; E.idx = -2; }
  else if (e.key.toLowerCase() === 'f') alternarFoco();
}
function alternarFoco() {
  const E = Estudio, u = E.ui; if (!u) return;
  const on = document.body.classList.toggle('foco');
  (on ? u.mini : $('.player')).append(E.video);
  E.idx = -2; E.alvo = null;
  if (on) aviso('Modo foco: tecla F ou Esc para sair. Barra de espaço grava/para.', 3800);
}
function atualizarBotoes() {
  const E = Estudio, u = E.ui; if (!u) return;
  const gr = E.estado === 'gravando' || E.estado === 'contagem';
  u.btnGravar.textContent = gr ? '■ Parar' : '● Gravar'; u.btnGravar.classList.toggle('rec', true);
  u.btnEnsaio.textContent = E.estado === 'ensaio' ? '⏸ Pausar' : '▶ Ensaiar'; u.btnEnsaio.disabled = gr;
  u.estadoRec.classList.toggle('on', E.estado === 'gravando');
  u.dica.textContent = E.estado === 'gravando' ? 'Leia no ritmo do destaque. Barra de espaço para parar.' : E.estado === 'ensaio' ? 'Ensaio: nada está sendo gravado.' : 'Acompanhe o destaque azul.';
}
function pausarEnsaio() { const E = Estudio; E.video.pause(); E.estado = 'parado'; atualizarBotoes(); }
function ensaiar() {
  const E = Estudio; if (E.estado === 'ensaio') return pausarEnsaio();
  if (E.estado !== 'parado') return;
  E.estado = 'ensaio'; E.video.play(); atualizarBotoes();
}
async function gravar() {
  const E = Estudio; if (E.estado !== 'parado' && E.estado !== 'ensaio') return;
  if (!Mic.ligado) { try { await Mic.ligar(); } catch (e) { aviso('Ligue o microfone no painel antes de gravar.', 5000); return; } }
  E.video.pause(); E.video.currentTime = 0; E.estado = 'contagem'; atualizarBotoes();
  Mic.comecar();                                   // captura já, para não perder o começo da fala
  const c = E.ui.contagem; c.classList.add('on');
  for (let n = 3; n >= 1 && E.estado === 'contagem'; n--) { $('span', c).textContent = n; await sleep(1000); }
  c.classList.remove('on');
  if (E.estado !== 'contagem') return;
  try { await E.video.play(); } catch (e) { aviso('O navegador não deixou iniciar o vídeo.'); parar(); return; }
  E.tPlay = Mic.ctx.currentTime; E.estado = 'gravando'; atualizarBotoes();
}
async function parar(fim) {
  const E = Estudio, estavaGravando = E.estado === 'gravando';
  E.ui.contagem.classList.remove('on'); E.video.pause();
  const vt = E.video.currentTime;
  E.estado = 'parado'; atualizarBotoes();
  const r = await Mic.terminar();
  if (!estavaGravando || r.tCap == null) { aviso('Gravação cancelada.'); return; }
  const dur = E.video.duration || E.parte.duracao;
  const ini = Math.round((E.tPlay + (Mic.ctx.baseLatency || 0) - r.tCap + cfg.syncMs / 1000) * SR);
  const n = Math.min(r.pcm.length - Math.max(0, ini), Math.ceil(dur * SR));
  const trecho = r.pcm.subarray(Math.max(0, ini), Math.max(0, ini) + Math.max(0, n));
  const i16 = new Int16Array(trecho.length); for (let i = 0; i < trecho.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(trecho[i] * 32767)));
  const take = { parte: E.parte.id, ts: Date.now(), dur: vt, incompleto: !fim && vt < dur - 1, pcm: i16.buffer };
  take.id = await BD.add(take); escolher(E.parte.id, take.id);
  await listarTakes();
  aviso(take.incompleto ? 'Take salvo (incompleto: você parou antes do fim do vídeo).' : 'Take salvo!');
  abrirTake(take);
}
function loop() {
  const E = Estudio, v = E.video; if (!v) return;
  const dur = v.duration || E.parte.duracao, t = v.currentTime, u = E.ui;
  u.prog.style.width = (t / dur * 100) + '%'; u.tCur.textContent = fmt(t);
  if (E.estado === 'gravando' && Mic.ctx) { /* cronômetro simples */ u.estadoRec.lastChild.textContent = `GRAVANDO ${fmt(t)}`; }
  const agora = t + cfg.lead;
  // palavra atual
  const W = E.palavras; let lo = 0, hi = W.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].t <= agora) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i !== E.idx) {
    const a = E.idx;
    if (a < -1 || Math.abs(i - a) > 400) { W.forEach((w, k) => w.el.className = k < i ? 'w dito' : k === i ? 'w agora' : 'w'); }
    else if (i > a) { if (a >= 0) W[a].el.className = 'w dito'; for (let k = Math.max(0, a + 1); k < i; k++) W[k].el.className = 'w dito'; if (i >= 0) W[i].el.className = 'w agora'; }
    else { if (a >= 0) W[a].el.className = 'w'; for (let k = i + 1; k < a; k++) W[k].el.className = 'w'; if (i >= 0) W[i].el.className = 'w agora'; }
    E.idx = i; E.alvo = null;
  }
  // pausas
  let pa = null;
  for (const p of E.pausas) { const on = t >= p.t0 - 0.5 && t < p.t1; p.el.classList.toggle('ativa', on); if (on) { pa = p; p.cont.textContent = Math.max(0, Math.ceil(p.t1 - t)) + ' s'; } else p.cont.textContent = ''; }
  const alvo = pa ? pa.el : (i >= 0 ? W[i].el : W[0] && W[0].el);
  if (alvo && alvo !== E.alvo) {
    E.alvo = alvo;
    const H = u.miolo.clientHeight; const y = alvo.offsetTop + alvo.offsetHeight / 2;
    u.tele.style.transform = `translate(-50%, ${Math.round(H * 0.40 - y)}px)`;
  }
}

/* ------------------------------------------------------------------ takes */
async function listarTakes() {
  const E = Estudio, el = E.ui.takesEl, lista = (await BD.lista(E.parte.id)).sort((a, b) => b.ts - a.ts), sel = escolhido(E.parte.id);
  el.innerHTML = '';
  if (!lista.length) { el.append(h('p', { class: 'ajuda' }, 'Nenhuma gravação ainda. Clique em “Gravar”.')); return; }
  lista.forEach((t, k) => {
    const n = lista.length - k, d = new Date(t.ts);
    el.append(h('div', { class: 'take' + (t.id === sel || (!sel && k === 0) ? ' sel' : '') },
      h('div', {}, h('b', {}, `Take ${n}`), ' ', t.incompleto ? h('span', { class: 'selo aviso' }, 'incompleto') : null, h('br'), h('small', {}, `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${fmt(t.dur)}`)),
      h('span', { class: 'selo ' + (t.id === sel || (!sel && k === 0) ? 'ok' : '') }, t.id === sel || (!sel && k === 0) ? '★ vai exportar' : ''),
      h('div', { class: 'acoes' },
        h('button', { class: 'btn peq', onclick: () => abrirTake(t) }, 'Ouvir'),
        h('button', { class: 'btn peq', onclick: () => { escolher(E.parte.id, t.id); listarTakes(); } }, 'Usar este'),
        h('button', { class: 'btn peq fant', onclick: async () => { if (confirm('Excluir este take?')) { await BD.del(t.id); listarTakes(); } } }, 'Excluir'))));
  });
}
function desenharOnda(canvas, x) {
  const w = canvas.width = canvas.clientWidth * 2, hh = canvas.height = canvas.clientHeight * 2, g = canvas.getContext('2d');
  g.clearRect(0, 0, w, hh); g.fillStyle = '#4D8DFF'; const passo = Math.max(1, Math.floor(x.length / w));
  for (let i = 0; i < w; i++) { let m = 0; for (let k = i * passo; k < (i + 1) * passo && k < x.length; k++) m = Math.max(m, Math.abs(x[k])); const a = Math.max(1, m * hh * 0.95); g.fillRect(i, (hh - a) / 2, 1, a); }
}
async function abrirTake(take) {
  const d = $('#dlg'), E = Estudio; d.innerHTML = '';
  const t = await BD.get(take.id), x = int16ParaFloat(t.pcm), dur = E.video ? (E.video.duration || E.parte.duracao) : E.parte.duracao;
  const pico = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0), cnv = h('canvas', { class: 'onda' });
  let fonte = null, parou = null;
  const parar_ = () => { try { fonte && fonte.stop(); } catch (e) {} fonte = null; if (E.video) E.video.pause(); };
  const ouvirSo = async () => {
    parar_(); const ctx = Mic.ctx || (window.__ctxPre = window.__ctxPre || new AudioContext({ sampleRate: SR })); await ctx.resume();
    const b = ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0); fonte = ctx.createBufferSource(); fonte.buffer = b; fonte.connect(ctx.destination); fonte.start();
  };
  const ouvirComVideo = async () => {
    parar_(); const ctx = Mic.ctx || (window.__ctxPre = window.__ctxPre || new AudioContext({ sampleRate: SR })); await ctx.resume();
    const v = E.video; v.muted = false; v.currentTime = 0;
    const b = ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0); fonte = ctx.createBufferSource(); fonte.buffer = b; fonte.connect(ctx.destination);
    await v.play(); fonte.start(ctx.currentTime + (cfg.syncMs < 0 ? -cfg.syncMs / 1000 : 0));
  };
  d.append(h('h2', {}, 'Ouvir o take'), h('p', { class: 'ajuda' }, 'Tudo alinhado ao começo do vídeo. “Ouvir com o vídeo” toca a sua voz junto com a aula, para você conferir.'), cnv,
    h('div', { class: 'resumo' }, h('div', {}, 'Duração gravada', h('b', {}, fmt(x.length / SR))), h('div', {}, 'Duração do vídeo', h('b', {}, fmt(dur))), h('div', {}, 'Volume de pico', h('b', {}, (20 * Math.log10(pico + 1e-9)).toFixed(1) + ' dB'))),
    h('div', { class: 'linha-btn' },
      h('button', { class: 'btn prim', onclick: ouvirComVideo }, '▶ Ouvir com o vídeo'),
      h('button', { class: 'btn', onclick: ouvirSo }, 'Só a voz'),
      h('button', { class: 'btn fant', onclick: parar_ }, 'Parar'),
      h('button', { class: 'btn', onclick: () => { escolher(E.parte.id, t.id); listarTakes(); aviso('Este take será exportado.'); } }, 'Usar este take'),
      h('button', { class: 'btn fant', onclick: () => { parar_(); if (E.video) E.video.muted = !cfg.somVideo; d.close(); } }, 'Fechar')));
  d.showModal(); desenharOnda(cnv, x);
}

/* ------------------------------------------------------------------ exportação */
async function dialogoExportar(parte) {
  const takes = (await BD.lista(parte.id)).sort((a, b) => b.ts - a.ts);
  if (!takes.length) { aviso('Grave esta aula primeiro.'); return; }
  const d = $('#dlg'); d.innerHTML = '';
  const sel = escolhido(parte.id), padrao = takes.find(t => t.id === sel) || takes[0];
  const seletor = h('select', {}, ...takes.map((t, k) => h('option', { value: t.id }, `Take ${takes.length - k} · ${fmt(t.dur)}${t.incompleto ? ' (incompleto)' : ''}`)));
  seletor.value = padrao.id;
  const op = { norm: true, alvo: cfg.alvoLufs, hpf: cfg.hpf, nr: cfg.nr, deslMs: 0 };
  const c = (k, tit, dica) => { const i = h('input', { type: 'checkbox' }); i.checked = !!op[k]; i.addEventListener('change', () => { op[k] = i.checked; if (k === 'hpf' || k === 'nr') { cfg[k] = i.checked; salvarCfg(); } }); return h('label', { class: 'chk' }, i, h('span', {}, tit, h('small', {}, dica))); };
  const desl = h('input', { type: 'number', value: 0, step: 10 }); desl.addEventListener('input', () => op.deslMs = +desl.value || 0);
  const out = h('div', { class: 'resumo', style: 'display:none' });
  const dur = await duracaoVideo(parte);
  const gerar = async tipo => {
    const take = await BD.get(+seletor.value); out.style.display = 'grid'; out.innerHTML = '<div style="grid-column:1/-1">Processando…</div>'; await sleep(40);
    const r = processar(int16ParaFloat(take.pcm), dur, op);
    const blob = tipo === 'wav' ? codificarWav(r.x) : codificarMp3(r.x, 192);
    out.innerHTML = ''; out.append(h('div', {}, 'Volume (antes → depois)', h('b', {}, `${r.lufsAntes.toFixed(1)} → ${r.lufsDepois.toFixed(1)} LUFS`)), h('div', {}, 'Pico', h('b', {}, r.picoDb.toFixed(1) + ' dB')), h('div', {}, 'Duração', h('b', {}, fmt(dur) + ' (igual ao vídeo)')));
    return { blob, r };
  };
  d.append(h('h2', {}, `Exportar · ${parte.titulo}`),
    h('p', { class: 'ajuda' }, `O arquivo sai com a duração exata do vídeo (${fmt(dur)}), 48 kHz, mono. É só colocar o MP3 no início da aula, na linha de áudio.`),
    h('label', { class: 'campo' }, 'Take'), seletor,
    c('norm', `Nivelar o volume para ${op.alvo} LUFS`, 'Padrão de plataformas de vídeo. Evita voz baixa ou estourada.'),
    c('hpf', 'Cortar graves indesejados (80 Hz)', 'Tira rumble de mesa e vento.'),
    c('nr', 'Reduzir chiado entre as frases (leve)', 'Não afeta a voz.'),
    h('label', { class: 'campo' }, 'Ajuste fino de sincronia (ms, + atrasa a voz, − adianta)'), desl, out,
    h('div', { class: 'linha-btn' },
      h('button', { class: 'btn prim', onclick: async () => { const { blob } = await gerar('mp3'); baixar(blob, `${parte.arquivo}_narracao.mp3`); aviso('MP3 pronto, veja a pasta Downloads.'); } }, '⬇ Baixar MP3'),
      h('button', { class: 'btn', onclick: async () => { const { blob } = await gerar('wav'); baixar(blob, `${parte.arquivo}_narracao.wav`); } }, 'Baixar WAV'),
      h('button', { class: 'btn fant', onclick: () => d.close() }, 'Fechar')));
  d.showModal();
}
async function exportarTodos() {
  const feitos = [];
  for (const p of PARTES) {
    const takes = (await BD.lista(p.id)).sort((a, b) => b.ts - a.ts); if (!takes.length) continue;
    const take = takes.find(t => t.id === escolhido(p.id)) || takes[0], dur = await duracaoVideo(p);
    aviso(`Processando ${p.titulo}…`, 2500); await sleep(60);
    const r = processar(int16ParaFloat(take.pcm), dur, { norm: true, alvo: cfg.alvoLufs, hpf: cfg.hpf, nr: cfg.nr, deslMs: 0 });
    baixar(codificarMp3(r.x, 192), `${p.arquivo}_narracao.mp3`); feitos.push(p.titulo); await sleep(700);
  }
  aviso(feitos.length ? `Exportado: ${feitos.join(', ')}.` : 'Ainda não há gravações para exportar.', 4500);
}

/* ------------------------------------------------------------------ início */
(async function () {
  await BD.abrir();
  telaPainel();
  window.__estudio = { Mic, BD, processar, codificarMp3, lufs, cfg, Estudio, ir };   // para testes
})();
