'use strict';
/* Estúdio de Narração · A Liga  (no ritmo do narrador, com câmera)
   O narrador lê o roteiro no ritmo dele; o texto acompanha a voz (reconhecimento de fala + ritmo) e a gravação é
   feita por trecho, com imagem (câmera frontal ou traseira) e som. O pacote exportado (MP4 por trecho + manifesto)
   serve de base para alinhar as animações. Funciona no computador e no celular. */

const SR = 48000;                       // taxa de gravação e de exportação do áudio (padrão de vídeo)
const ATRASO_MP3 = 1105;                // atraso do codificador+decodificador MP3, compensado na exportação
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const celular = (() => { try { return matchMedia('(pointer:coarse)').matches || innerWidth < 700; } catch (e) { return false; } })();
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
const PADRAO = { eco: false, ruido: true, agc: false, dev: '', fonte: celular ? 34 : 56, espelho: false, seguirVoz: !celular, wpm: 150, autoParar: true,
                 camera: 'user', alvoLufs: -16, hpf: true, nr: true };
let cfg = { ...PADRAO };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('estudio-cfg3') || '{}')); } catch (e) {}
const salvarCfg = () => { try { localStorage.setItem('estudio-cfg3', JSON.stringify(cfg)); } catch (e) {} };
const aviso = (t, ms = 3200) => { const a = $('#aviso'); a.textContent = t; a.classList.add('on'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('on'), ms); };
const chaveBloco = (parte, bloco) => `${parte.id}/${bloco.id}`;
const palavrasDoBloco = b => b.paragrafos.join(' ').split(/\s+/).filter(Boolean).length;
const extDe = mime => /mp4/.test(mime || '') ? 'mp4' : 'webm';
const mb = n => (n / 1048576).toFixed(n > 1.05e8 ? 0 : 1) + ' MB';

/* ------------------------------------------------------------------ armazenamento dos takes */
const BD = {
  db: null, mem: [], seq: 1,
  async abrir() {
    try {
      await new Promise((res, rej) => {
        const r = indexedDB.open('estudio-narracao-aliga', 3);
        r.onupgradeneeded = () => {
          if (r.result.objectStoreNames.contains('takes')) r.result.deleteObjectStore('takes');   // formato novo (por bloco, com imagem)
          r.result.createObjectStore('takes', { keyPath: 'id', autoIncrement: true }).createIndex('bloco', 'bloco');
        };
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    } catch (e) { this.db = null; console.warn('IndexedDB indisponível, takes só nesta sessão', e); }
  },
  _req(modo, fn) { return new Promise((res, rej) => { const q = fn(this.db.transaction('takes', modo).objectStore('takes')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async add(t) {
    if (!this.db) { t.id = this.seq++; this.mem.push(t); return t.id; }
    try { return await this._req('readwrite', s => s.add(t)); }
    catch (e) { console.warn('Sem espaço no navegador, take só nesta sessão', e); t.id = 1e9 + this.seq++; this.mem.push(t); aviso('Pouco espaço no navegador: este take fica só enquanto a página estiver aberta. Baixe o pacote logo.', 7000); return t.id; }
  },
  async lista(bloco) { const m = this.mem.filter(t => t.bloco === bloco); if (!this.db) return m; return m.concat(await this._req('readonly', s => s.index('bloco').getAll(bloco))); },
  async get(id) { const m = this.mem.find(t => t.id === id); if (m || !this.db) return m; return this._req('readonly', s => s.get(id)); },
  async del(id) { this.mem = this.mem.filter(t => t.id !== id); if (!this.db) return; return this._req('readwrite', s => s.delete(id)); },
};
const escolhido = k => { try { return +localStorage.getItem('estudio-take3-' + k) || 0; } catch (e) { return 0; } };
const escolher = (k, id) => { try { localStorage.setItem('estudio-take3-' + k, id); } catch (e) {} };
async function takeDoBloco(k) { const l = (await BD.lista(k)).sort((a, b) => b.ts - a.ts); return l.find(t => t.id === escolhido(k)) || l[0] || null; }

/* a tela do celular não pode apagar durante a gravação */
const Tela = {
  lock: null,
  async ligar() { try { this.lock = await navigator.wakeLock.request('screen'); } catch (e) {} },
  async soltar() { try { if (this.lock) await this.lock.release(); } catch (e) {} this.lock = null; },
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Estudio.estado !== 'parado') Tela.ligar(); });

/* ------------------------------------------------------------------ microfone, câmera e gravador */
const CODIGO_WORKLET = `
class Gravador extends AudioWorkletProcessor {
  constructor(){ super(); this.on=false; this.buf=[]; this.n=0;
    this.port.onmessage=e=>{ if(e.data==='start'){this.on=true;this.buf=[];this.n=0;}
      else if(e.data==='stop'){this.on=false;this.flush();this.port.postMessage({fim:true});} }; }
  process(inputs){ const c=inputs[0]&&inputs[0][0];
    if(c&&this.on){ this.buf.push(new Float32Array(c)); this.n+=c.length; if(this.buf.length>=32) this.flush(); }
    return true; }
  flush(){ if(!this.buf.length) return; const o=new Float32Array(this.n); let p=0; for(const b of this.buf){o.set(b,p);p+=b.length;}
    this.port.postMessage({pcm:o.buffer},[o.buffer]); this.buf=[]; this.n=0; }
}
registerProcessor('gravador', Gravador);`;
const MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

const Mic = {
  ctx: null, stream: null, analyser: null, ligado: false, gravando: false, partes: [], aguardandoFim: null, mr: null, vpedacos: [], mime: '', semCamera: false,
  temVideo() { return !!(this.stream && this.stream.getVideoTracks().length); },
  async ligar() {
    await this.desligar();
    const audio = { channelCount: 1, echoCancellation: cfg.eco, noiseSuppression: cfg.ruido, autoGainControl: cfg.agc };
    if (cfg.dev) audio.deviceId = { exact: cfg.dev };
    this.semCamera = false;
    if (cfg.camera !== 'off') {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: { ideal: cfg.camera }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      } catch (e) { console.warn('Sem câmera, seguindo só com áudio', e); this.semCamera = true; }
    }
    if (!this.stream) this.stream = await navigator.mediaDevices.getUserMedia({ audio });
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
        if (e.data.pcm) this.partes.push(new Float32Array(e.data.pcm));
        if (e.data.fim && this.aguardandoFim) this.aguardandoFim();
      };
      src.connect(this.no); this.no.connect(mudo);
    } catch (err) {                       // plano B para navegadores sem AudioWorklet
      console.warn('AudioWorklet indisponível, usando ScriptProcessor', err);
      const sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = e => { if (this.gravando) this.partes.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(sp); sp.connect(mudo); this.sp = sp; this.no = null;
    }
    this.ligado = true; this.estado(); atualizarPrevias();
    return this.stream.getAudioTracks()[0];
  },
  async desligar() {
    this.ligado = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) { try { await this.ctx.close(); } catch (e) {} }
    this.ctx = this.stream = this.analyser = this.no = this.sp = null; this.estado(); atualizarPrevias();
  },
  comecar(semImagem) {
    this.partes = []; this.gravando = true; this.mr = null; this.vpedacos = [];
    if (this.no) this.no.port.postMessage('start');
    if (!semImagem && this.temVideo() && window.MediaRecorder) {
      const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';
      try {
        this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: celular ? 4e6 : 6e6, audioBitsPerSecond: 192000 } : {});
        this.mr.ondataavailable = e => { if (e.data && e.data.size) this.vpedacos.push(e.data); };
        this.mr.start(1000);
        this.mime = (this.mr.mimeType || mime || 'video/webm').split(';')[0];
      } catch (e) { this.mr = null; aviso('Não consegui gravar a imagem; só o áudio será salvo.', 5000); }
    }
  },
  async terminar() {
    this.gravando = false;
    let video = null;
    if (this.mr) {
      const mr = this.mr; this.mr = null;
      video = await new Promise(res => { mr.onstop = () => res(this.vpedacos.length ? new Blob(this.vpedacos, { type: this.mime }) : null); try { mr.stop(); } catch (e) { res(null); } });
      this.vpedacos = [];
    }
    if (this.no) await new Promise(r => { this.aguardandoFim = r; this.no.port.postMessage('stop'); setTimeout(r, 1500); });
    const n = this.partes.reduce((a, b) => a + b.length, 0), pcm = new Float32Array(n); let p = 0;
    for (const b of this.partes) { pcm.set(b, p); p += b.length; }
    this.partes = []; return { pcm, video, mime: video ? this.mime : '' };
  },
  nivel() {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(d);
    let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); return m;
  },
  estado() { const e = $('#micEstado'); if (!e) return; e.textContent = this.ligado ? (this.temVideo() ? 'Câmera e microfone ligados' : 'Microfone ligado') : 'Desligado'; e.classList.toggle('on', this.ligado); },
};
(function medidor() {
  const f = () => {
    const n = Mic.nivel(), db = 20 * Math.log10(n + 1e-6), pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    $$('.medidor i').forEach(i => i.style.width = pct + '%');
    if (n > 0.02) Estudio.ultimoSom = performance.now();
    requestAnimationFrame(f);
  }; f();
})();
/* mostra a imagem da câmera em todas as janelinhas de prévia */
function atualizarPrevias() {
  $$('video.previa').forEach(v => {
    const tem = Mic.temVideo();
    v.classList.toggle('off', !tem); v.classList.toggle('espelhada', tem && cfg.camera === 'user');
    v.muted = true; v.playsInline = true;
    if (tem) { if (v.srcObject !== Mic.stream) v.srcObject = Mic.stream; v.play().catch(() => {}); } else v.srcObject = null;
  });
}
function segCamera(aoMudar) {
  const itens = [['user', 'Frontal'], ['environment', 'Traseira'], ['off', 'Sem imagem']];
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': 'Câmera' });
  const pintar = () => $$('button', el).forEach(b => b.classList.toggle('sel', b.dataset.v === cfg.camera));
  for (const [v, t] of itens) el.append(h('button', { 'data-v': v, onclick: async () => {
    if (Estudio.estado !== 'parado') return;
    cfg.camera = v; salvarCfg(); pintar(); atualizarPrevias(); if (Mic.ligado) await ligarMic(); if (aoMudar) aoMudar();
  } }, t));
  pintar(); return el;
}

/* ------------------------------------------------------------------ reconhecimento de fala (acompanhar a voz) */
const reconhecimentoDisponivel = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
function iniciarReconhecimento(seg, aoErro) {
  const SRec = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SRec) return null;
  const r = new SRec(); r.lang = 'pt-BR'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  let vivo = true, base = 0;
  r.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) seg.hipotese(base + i, e.results[i][0].transcript, e.results[i].isFinal, performance.now()); };
  r.onerror = e => { if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(e.error)) { vivo = false; aoErro(e.error); } };
  r.onend = () => { if (vivo) { base += 1000; try { r.start(); } catch (e) {} } };
  try { r.start(); } catch (e) { return null; }
  return { parar() { vivo = false; try { r.stop(); } catch (e) {} } };
}

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
  const q = Math.round(0.02 * SR), n = Math.floor(x.length / q); if (n < 10) return x;
  const rms = new Float32Array(n);
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
  const gmin = new Float32Array(len), dq = [];
  for (let i = len - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i); while (dq[0] > i + N) dq.shift();
    gmin[i] = need[dq[0]];
  }
  const y = new Float32Array(len); let acc = 0;
  for (let i = 0; i < len; i++) { acc += gmin[i]; if (i > N) acc -= gmin[i - N - 1]; y[i] = x[i] * (acc / Math.min(i + 1, N + 1)); }
  return y;
}
/* onde a fala começa e termina (índices de amostra), com uma folga pequena antes e depois */
function limitesFala(x, antes = 0.3, depois = 0.4) {
  const q = Math.round(0.02 * SR), n = Math.floor(x.length / q); if (n < 5) return null;
  const db = new Float32Array(n); let pico = -120;
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * q; k < (i + 1) * q; k++) s += x[k] * x[k]; db[i] = 10 * Math.log10(s / q + 1e-12); pico = Math.max(pico, db[i]); }
  const lim = Math.max(-52, pico - 38);
  let a = 0, b = n - 1; while (a < n && db[a] < lim) a++; while (b > a && db[b] < lim) b--;
  if (a >= n) return null;
  return [Math.max(0, Math.round(a * q - antes * SR)), Math.min(x.length, Math.round((b + 1) * q + depois * SR))];
}
const aparar = x => { const l = limitesFala(x); return l ? x.slice(l[0], l[1]) : x; };
function processar(pcm, op) {
  let x = op.hpf ? passaAlta(pcm) : Float32Array.from(pcm);
  const l = limitesFala(x) || [0, x.length];
  x = x.slice(l[0], l[1]);
  if (op.nr) x = reduzirRuido(x);
  const antes = lufs(x);
  if (op.norm && antes > -69) { const g = Math.pow(10, (op.alvo - antes) / 20); for (let i = 0; i < x.length; i++) x[i] *= g; x = limitar(x); }
  else x = limitar(x, 0.98);
  const fade = Math.min(Math.round(0.015 * SR), x.length >> 2); for (let i = 0; i < fade; i++) { const f = i / fade; x[i] *= f; x[x.length - 1 - i] *= f; }
  let pico = 0; for (let i = 0; i < x.length; i++) pico = Math.max(pico, Math.abs(x[i]));
  return { x, dur: x.length / SR, ini: l[0] / SR, fim: l[1] / SR, lufsAntes: antes, lufsDepois: lufs(x), picoDb: 20 * Math.log10(pico + 1e-9) };
}
function paraInt16(x, atraso = 0) {
  const y = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) { const v = x[i + atraso] || 0; y[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }
  return y;
}
function codificarMp3(x, kbps = 192) {
  const pcm = paraInt16(x, ATRASO_MP3);
  const enc = new lamejs.Mp3Encoder(1, SR, kbps), partes = [], T = 1152;
  for (let i = 0; i < pcm.length; i += T) { const b = enc.encodeBuffer(pcm.subarray(i, i + T)); if (b.length) partes.push(new Uint8Array(b)); }
  const f = enc.flush(); if (f.length) partes.push(new Uint8Array(f));
  return new Blob(partes, { type: 'audio/mpeg' });
}
const int16ParaFloat = buf => { const i = new Int16Array(buf), f = new Float32Array(i.length); for (let k = 0; k < i.length; k++) f[k] = i[k] / 32768; return f; };
function baixar(blob, nome) {
  const a = h('a', { href: URL.createObjectURL(blob), download: nome }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
}
/* ZIP simples (sem compressão): MP3 e MP4 já são comprimidos. Lê um arquivo por vez para poupar memória. */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function criarZip(arquivos, progresso) {           // [{nome, dados:Uint8Array | blob:Blob}]
  const enc = new TextEncoder(), locais = [], centrais = []; let desloc = 0, k = 0;
  const agora = new Date(), dt = ((agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1)) & 0xFFFF,
        dd = (((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate()) & 0xFFFF;
  for (const a of arquivos) {
    const bytes = a.dados || new Uint8Array(await a.blob.arrayBuffer()), parte = a.blob || a.dados;
    const nome = enc.encode(a.nome), crc = crc32(bytes), n = bytes.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true);
    lh.setUint16(26, nome.length, true); lh.setUint16(28, 0, true);
    locais.push(new Uint8Array(lh.buffer), nome, parte);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true);
    ch.setUint16(28, nome.length, true); ch.setUint32(42, desloc, true);
    centrais.push(new Uint8Array(ch.buffer), nome);
    desloc += 30 + nome.length + n;
    if (progresso) progresso(++k, arquivos.length);
    await sleep(0);
  }
  const tamC = centrais.reduce((s, p) => s + p.length, 0), fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true); fim.setUint32(12, tamC, true); fim.setUint32(16, desloc, true);
  return new Blob([...locais, ...centrais, new Uint8Array(fim.buffer)], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ navegação */
function ir(tela, id) {
  Estudio.sair();
  document.body.classList.remove('foco', 'gravando');
  tela === 'estudio' ? telaEstudio(PARTES.find(p => p.id === id)) : telaPainel();
}
$('#btnPainel').addEventListener('click', () => ir('painel'));

/* ------------------------------------------------------------------ painel */
async function telaPainel() {
  const raiz = $('#tela'); raiz.innerHTML = '';
  const pg = h('div', { class: 'pagina' });
  pg.append(
    h('h1', {}, 'Narração das aulas'),
    h('p', { class: 'sub' }, 'Leia o roteiro no seu ritmo. O texto acompanha a sua voz, e o aplicativo grava a sua imagem e o seu som, trecho por trecho. Quando terminar, baixe o pacote: as animações das aulas serão ajustadas ao seu tempo de fala.'),
    h('div', { class: 'passos' },
      h('div', { class: 'passo' }, h('b', {}, '1'), h('span', {}, 'Ligue a câmera e o microfone e confira o enquadramento.')),
      h('div', { class: 'passo' }, h('b', {}, '2'), h('span', {}, 'Grave cada trecho no seu ritmo. Pode repetir quantas vezes quiser.')),
      h('div', { class: 'passo' }, h('b', {}, '3'), h('span', {}, 'Baixe o pacote (ZIP) e envie de volta.'))));

  const sel = h('select', { id: 'selMic' }, h('option', { value: '' }, 'Microfone padrão'));
  const previa = h('video', { class: 'previa previa-painel off', playsinline: '', autoplay: '', muted: '' });
  const bloco = h('div', { class: 'cartao mic-bloco' },
    h('div', {},
      h('h2', {}, 'Câmera e microfone'),
      h('label', { class: 'campo' }, 'Câmera'), segCamera(),
      h('label', { class: 'campo', for: 'selMic' }, 'Microfone'), sel,
      h('div', { class: 'linha-btn' },
        h('button', { class: 'btn prim', id: 'btnLigar', onclick: ligarMic }, 'Ligar câmera e microfone'),
        h('button', { class: 'btn', id: 'btnTeste', onclick: testeMic }, 'Teste de 5 s')),
      h('p', { class: 'ajuda' }, 'Apoie o aparelho em um tripé ou na estante, com o rosto enquadrado. No celular, deite o aparelho para o vídeo sair na horizontal, igual ao das aulas. Fale a uns 20 cm do microfone, em um lugar silencioso.'),
      previa),
    h('div', {},
      h('h2', {}, 'Como o texto acompanha você'),
      chk('seguirVoz', 'Acompanhar a minha voz', reconhecimentoDisponivel() ? 'Usa o reconhecimento de fala do Chrome (precisa de internet). No celular pode competir com o microfone; se o texto travar, desmarque e ele segue o seu ritmo médio.' : 'Este navegador não tem reconhecimento de fala: o texto vai seguir o seu ritmo médio (use o Chrome no computador para acompanhar a voz).'),
      chk('ruido', 'Reduzir ruído do ambiente', 'Ajuda contra ventilador e ar-condicionado.'),
      chk('eco', 'Cancelar eco', 'Só se estiver sem fone de ouvido.')));
  pg.append(h('div', { class: 'grade' }, bloco));
  sel.value = cfg.dev; sel.addEventListener('change', () => { cfg.dev = sel.value; salvarCfg(); if (Mic.ligado) ligarMic(); });
  listarMics(sel); atualizarPrevias();

  const lista = h('div', { class: 'partes' });
  for (const p of PARTES) {
    let feitos = 0;
    const itens = [];
    for (const b of p.blocos) {
      const t = await takeDoBloco(chaveBloco(p, b)); if (t) feitos++;
      itens.push(h('li', { class: t ? 'ok' : '' }, h('span', { class: 'ck ' + (t ? 'ok' : '') }, t ? '✓' : '○'), b.titulo, h('small', {}, t ? fmt(t.dur) + (t.video ? ' · imagem' : '') : `${palavrasDoBloco(b)} palavras`)));
    }
    lista.append(h('article', { class: 'cartao parte' },
      h('h3', {}, `${p.numero}. ${p.titulo}`),
      h('div', { class: 'meta' }, h('span', { class: 'selo ' + (feitos === p.blocos.length ? 'ok' : '') }, `${feitos} de ${p.blocos.length} trechos gravados`)),
      h('ul', { class: 'lista-blocos' }, itens),
      h('div', { class: 'linha-btn', style: 'margin-top:auto' },
        h('button', { class: 'btn prim', onclick: () => ir('estudio', p.id) }, feitos ? 'Continuar gravando' : 'Gravar esta aula'),
        feitos ? h('button', { class: 'btn', onclick: () => dialogoPacote(p) }, 'Baixar esta aula') : null)));
  }
  pg.append(h('h2', { style: 'margin-top:34px' }, 'Aulas'), lista,
    h('div', { class: 'linha-btn' }, h('button', { class: 'btn prim', onclick: () => dialogoPacote() }, '⬇ Baixar tudo (ZIP)')));
  raiz.append(pg);
  Mic.estado();
}
function chk(chave, titulo, dica) {
  const i = h('input', { type: 'checkbox', id: 'c_' + chave });
  i.checked = !!cfg[chave];
  i.addEventListener('change', () => { cfg[chave] = i.checked; salvarCfg(); if (Mic.ligado && ['ruido', 'eco', 'agc'].includes(chave)) aviso('Toque em “Ligar” de novo para aplicar.'); });
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
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { aviso('Este navegador não libera câmera/microfone aqui. Abra o endereço seguro (https) no Chrome ou Safari.', 7000); return false; }
  try {
    await Mic.ligar();
    const sel = $('#selMic'); if (sel && sel.options.length <= 1) listarMics(sel);
    aviso(Mic.semCamera ? 'Não consegui abrir a câmera; vou gravar só o áudio. Confira a permissão da câmera.' : Mic.temVideo() ? 'Câmera e microfone ligados. Fale para ver o medidor mexer.' : 'Microfone ligado. Fale para ver o medidor mexer.', Mic.semCamera ? 6000 : 3200);
    return true;
  } catch (e) {
    aviso(e.name === 'NotAllowedError' ? 'O navegador bloqueou o microfone. Toque no cadeado da barra de endereço e permita.' : 'Não consegui abrir o microfone: ' + e.message, 6000);
    return false;
  }
}
async function testeMic() {
  if (!Mic.ligado && !(await ligarMic())) return;
  aviso('Gravando 5 segundos… fale normalmente.', 5200);
  Mic.comecar(true); await sleep(5000); const { pcm: x } = await Mic.terminar();
  const pico = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (pico < 0.003) { aviso('Quase não captei som. Confira se o microfone certo está selecionado.', 6000); return; }
  const b = Mic.ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0);
  const s = Mic.ctx.createBufferSource(); s.buffer = b; s.connect(Mic.ctx.destination); s.start();
  aviso(`Ouça o teste. Pico: ${(20 * Math.log10(pico)).toFixed(0)} dB ${pico > 0.95 ? '(alto demais, afaste-se um pouco)' : pico < 0.05 ? '(baixo, aproxime-se um pouco)' : '(bom)'}`, 6500);
}

/* ------------------------------------------------------------------ estúdio (roteiro que acompanha a voz) */
const Estudio = {
  parte: null, bloco: null, estado: 'parado', palavras: [], seg: null, destIdx: -2, alvoEl: null, raf: 0, rec: null,
  ultimoSom: 0, tIni: 0, modo: 'ritmo', ui: null,
  sair() {
    const E = this; cancelAnimationFrame(E.raf); document.removeEventListener('keydown', teclas);
    if (E.rec) { E.rec.parar(); E.rec = null; }
    if (Mic.gravando) Mic.terminar();
    Tela.soltar();
    E.estado = 'parado'; E.parte = E.bloco = E.seg = E.ui = null;
  },
};

async function telaEstudio(parte, blocoId) {
  const E = Estudio; E.parte = parte;
  const raiz = $('#tela'); raiz.innerHTML = '';
  const lista = h('div', { class: 'blocos' }), takesEl = h('div', { class: 'takes' });
  const sFonte = h('input', { type: 'range', min: 24, max: 110, value: cfg.fonte });
  sFonte.addEventListener('input', () => { cfg.fonte = +sFonte.value; salvarCfg(); E.ui.tele.style.fontSize = cfg.fonte + 'px'; E.alvoEl = null; });
  const sRitmo = h('input', { type: 'range', min: 90, max: 220, step: 5, value: cfg.wpm });
  const rotRitmo = h('b', {}, `${cfg.wpm}`);
  sRitmo.addEventListener('input', () => { cfg.wpm = +sRitmo.value; rotRitmo.textContent = cfg.wpm; salvarCfg(); if (E.seg) E.seg.ajustarWpm(cfg.wpm, performance.now()); });
  const cEsp = h('input', { type: 'checkbox' }); cEsp.checked = cfg.espelho; cEsp.addEventListener('change', () => { cfg.espelho = cEsp.checked; salvarCfg(); E.ui.tele.classList.toggle('espelho', cfg.espelho); });
  const cAuto = h('input', { type: 'checkbox' }); cAuto.checked = cfg.autoParar; cAuto.addEventListener('change', () => { cfg.autoParar = cAuto.checked; salvarCfg(); });
  const cVoz = h('input', { type: 'checkbox' }); cVoz.checked = cfg.seguirVoz; cVoz.addEventListener('change', () => { cfg.seguirVoz = cVoz.checked; salvarCfg(); });

  const lado = h('aside', { class: 'lado' },
    h('button', { class: 'voltar', onclick: () => ir('painel') }, '← Voltar ao painel'),
    h('h2', {}, `${parte.numero}. ${parte.titulo}`),
    h('p', { class: 'ajuda', style: 'margin:-6px 0 0' }, 'Escolha o trecho, toque em Gravar e leia no seu ritmo.'),
    lista,
    h('h3', { class: 'peq' }, 'Takes deste trecho'), takesEl,
    h('h3', { class: 'peq' }, 'Câmera'), segCamera(),
    h('h3', { class: 'peq' }, 'Ajustes'),
    h('label', { class: 'faixa' }, 'Letra', sFonte),
    h('label', { class: 'faixa' }, h('span', {}, 'Ritmo médio ', rotRitmo, ' palavras/min'), sRitmo),
    h('label', { class: 'chk', style: 'margin-top:0' }, cVoz, h('span', {}, 'Acompanhar a minha voz', h('small', {}, 'Sem isso, o texto segue o ritmo médio acima.'))),
    h('label', { class: 'chk', style: 'margin-top:0' }, cAuto, h('span', {}, 'Parar sozinho ao terminar', h('small', {}, 'Encerra depois da última frase e de uns 2 s de silêncio.'))),
    h('label', { class: 'chk', style: 'margin-top:0' }, cEsp, h('span', {}, 'Espelhar texto', h('small', {}, 'Para teleprompter de vidro.'))),
    h('div', { class: 'linha-btn', style: 'margin:0' },
      h('button', { class: 'btn peq', onclick: () => alternarFoco() }, 'Modo foco'),
      h('button', { class: 'btn peq', onclick: () => dialogoVideo(parte) }, 'Ver a aula (referência)'),
      h('button', { class: 'btn peq', onclick: () => dialogoPacote(parte) }, 'Baixar esta aula')));

  const tele = h('div', { class: 'tele' }); tele.style.fontSize = cfg.fonte + 'px'; tele.classList.toggle('espelho', cfg.espelho);
  const miolo = h('div', { class: 'tele-miolo' }, tele, h('div', { class: 'guia' }));
  const contagem = h('div', { class: 'contagem' }, h('div', {}, h('span', {}, '3'), h('small', {}, 'Respire e comece a ler quando a contagem terminar')));
  const estadoRec = h('div', { class: 'estado-rec' }, h('i'), h('span', {}, 'GRAVANDO'));
  const dica = h('span', { class: 'mic-estado' }, '');
  const bGravar = h('button', { class: 'btn rec', onclick: () => (E.estado === 'parado' ? iniciarLeitura('gravar') : terminar()) }, '● Gravar este trecho');
  const bEnsaio = h('button', { class: 'btn', onclick: () => (E.estado === 'parado' ? iniciarLeitura('ensaio') : terminar()) }, '▶ Ensaiar');
  const bZero = h('button', { class: 'btn fant', onclick: () => { if (E.estado === 'parado') resetarPosicao(); } }, '↺ Do início');
  const bVirar = h('button', { class: 'btn fant', title: 'Trocar entre câmera frontal e traseira', onclick: async () => {
    if (E.estado !== 'parado') return;
    cfg.camera = cfg.camera === 'user' ? 'environment' : 'user'; salvarCfg(); await ligarMic(); $$('.seg').forEach(s => $$('button', s).forEach(b => b.classList.toggle('sel', b.dataset.v === cfg.camera)));
  } }, '⟲ Câmera');
  const rWpm = h('span', { class: 'mic-estado' }, '');
  const previa = h('video', { class: 'previa previa-tele off', playsinline: '', autoplay: '', muted: '' });
  const faixa = h('div', { class: 'faixa-tele' },
    h('div', { class: 'grp info' }, estadoRec, dica),
    h('div', { class: 'grp botoes' }, bGravar, bEnsaio, bZero, bVirar),
    h('div', { class: 'grp info' }, rWpm, h('div', { class: 'medidor' }, h('i'))));
  const area = h('section', { class: 'tele-area' }, miolo, previa, contagem, faixa);
  raiz.append(h('div', { class: 'estudio' }, lado, area));
  E.ui = { tele, lista, takesEl, contagem, estadoRec, dica, bGravar, bEnsaio, bZero, bVirar, rWpm, area, miolo, previa };
  document.addEventListener('keydown', teclas);
  const f = () => { loop(); E.raf = requestAnimationFrame(f); }; f();
  atualizarPrevias();
  await selecionarBloco(blocoId || (await primeiroPendente(parte)));
}
async function primeiroPendente(parte) {
  for (const b of parte.blocos) if (!(await takeDoBloco(chaveBloco(parte, b)))) return b.id;
  return parte.blocos[0].id;
}
async function listarBlocos() {
  const E = Estudio, el = E.ui.lista; el.innerHTML = '';
  for (const b of E.parte.blocos) {
    const t = await takeDoBloco(chaveBloco(E.parte, b));
    el.append(h('button', { class: 'bloco' + (E.bloco && E.bloco.id === b.id ? ' sel' : ''), onclick: () => E.estado === 'parado' && selecionarBloco(b.id) },
      h('span', { class: 'ck ' + (t ? 'ok' : '') }, t ? '✓' : '○'), h('span', { class: 'tit' }, b.titulo), h('small', {}, t ? fmt(t.dur) : `${palavrasDoBloco(b)} pal.`)));
  }
}
async function selecionarBloco(id) {
  const E = Estudio; E.bloco = E.parte.blocos.find(b => b.id === id) || E.parte.blocos[0];
  montarTele(E.bloco); resetarPosicao(); await listarBlocos(); await listarTakes(); atualizarBotoes();
}
function montarTele(bloco) {
  const E = Estudio, tele = E.ui.tele; tele.innerHTML = ''; E.palavras = [];
  const tokens = []; let nTok = 0;
  const addPalavra = (w, p) => {
    const tk = Seguir.tokenizar(w), sp = h('span', { class: 'w' }, w), i = E.palavras.length;
    sp.addEventListener('click', () => { if (E.estado !== 'parado' && E.seg) { E.seg.definir(E.palavras[i].ini, performance.now()); } });
    p.append(sp, ' '); E.palavras.push({ el: sp, ini: nTok }); tk.forEach(t => tokens.push(t)); nTok += tk.length;
  };
  tele.append(h('div', { class: 'tele-titulo' }, E.bloco.titulo));
  E.bloco.paragrafos.forEach((par, k) => {
    if (k > 0) tele.append(h('div', { class: 'tele-pausa leve' }, h('span', {}, '⏸'), h('span', {}, h('b', {}, 'Pausa curta'), 'Respire um instante e siga para a próxima fala.')));
    for (const sen of par.split(/(?<=[.!?])\s+/)) {
      const p = h('p', { class: 'frase' }); sen.split(/\s+/).filter(Boolean).forEach(w => addPalavra(w, p)); tele.append(p);
    }
  });
  tele.append(h('div', { class: 'tele-pausa leve' }, h('span', {}, '■'), h('span', {}, h('b', {}, 'Fim do trecho'), E.bloco.depois || 'Quando terminar, a gravação encerra sozinha (ou toque em Terminar).')));
  E.tokens = tokens; E.seg = Seguir.criar(tokens, { wpm: cfg.wpm });
}
function resetarPosicao() {
  const E = Estudio; if (!E.bloco) return;
  E.seg = Seguir.criar(E.tokens, { wpm: cfg.wpm }); E.destIdx = -2; E.alvoEl = null;
  E.palavras.forEach(w => w.el.className = 'w');
  E.ui.tele.style.transform = `translate(-50%, ${Math.round(E.ui.miolo.clientHeight * 0.30)}px)`;
}
function alternarFoco() {
  const E = Estudio; if (!E.ui) return;
  const on = document.body.classList.toggle('foco'); E.alvoEl = null;
  if (on) aviso('Modo foco: F ou Esc para sair.', 3200);
}
function atualizarBotoes() {
  const E = Estudio, u = E.ui; if (!u) return;
  const ativo = E.estado !== 'parado';
  u.bGravar.textContent = ativo ? '■ Terminar' : '● Gravar este trecho'; u.bEnsaio.disabled = ativo; u.bZero.disabled = ativo; u.bVirar.disabled = ativo;
  u.estadoRec.classList.toggle('on', E.estado === 'gravando');
  document.body.classList.toggle('gravando', ativo);                   // no celular, esconde o painel e deixa só o texto
  u.dica.textContent = E.estado === 'gravando' ? 'Leia no seu ritmo. O texto acompanha você.' : E.estado === 'ensaio' ? 'Ensaio: nada está sendo gravado.' : 'Toque em Gravar e leia no seu ritmo.';
}
function teclas(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('#dlg').open) return;
  const E = Estudio; if (!E.ui) return;
  if (e.code === 'Space') { e.preventDefault(); E.estado === 'parado' ? iniciarLeitura('gravar') : terminar(); }
  else if (e.key === 'Escape' && document.body.classList.contains('foco')) alternarFoco();
  else if (e.key.toLowerCase() === 'f') alternarFoco();
  else if (e.key === '+' || e.key === '=') { cfg.fonte = Math.min(110, cfg.fonte + 4); salvarCfg(); E.ui.tele.style.fontSize = cfg.fonte + 'px'; E.alvoEl = null; }
  else if (e.key === '-') { cfg.fonte = Math.max(24, cfg.fonte - 4); salvarCfg(); E.ui.tele.style.fontSize = cfg.fonte + 'px'; E.alvoEl = null; }
  else if (e.key === 'ArrowUp' && E.seg) { cfg.wpm = Math.min(220, cfg.wpm + 10); salvarCfg(); E.seg.ajustarWpm(cfg.wpm, performance.now()); }
  else if (e.key === 'ArrowDown' && E.seg) { cfg.wpm = Math.max(90, cfg.wpm - 10); salvarCfg(); E.seg.ajustarWpm(cfg.wpm, performance.now()); }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && E.seg && E.estado !== 'parado') {   // pula uma frase
    const ini = E.palavras.map(w => w.ini), i = destaqueAtual(performance.now());
    let k = i; if (e.key === 'ArrowRight') { while (k < E.palavras.length - 1 && !/[.!?]$/.test(E.palavras[k].el.textContent)) k++; k = Math.min(k + 1, E.palavras.length - 1); }
    else { k = Math.max(0, k - 1); while (k > 0 && !/[.!?]$/.test(E.palavras[k - 1].el.textContent)) k--; }
    E.seg.definir(ini[k], performance.now());
  }
}
function destaqueAtual(agora) {
  const E = Estudio, t = E.seg.visivel(agora); let lo = 0, hi = E.palavras.length - 1, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (E.palavras[m].ini <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
async function iniciarLeitura(modo) {
  const E = Estudio; if (E.estado !== 'parado') return;
  if (modo === 'gravar' && !Mic.ligado && !(await ligarMic())) return;
  resetarPosicao(); E.modo = modo; E.estado = 'contagem'; atualizarBotoes(); Tela.ligar();
  if (modo === 'gravar') Mic.comecar();                       // captura já na contagem; o começo é aparado na exportação
  const c = E.ui.contagem; c.classList.add('on');
  for (let n = 3; n >= 1 && E.estado === 'contagem'; n--) { $('span', c).textContent = n; await sleep(1000); }
  c.classList.remove('on'); if (E.estado !== 'contagem') return;
  const agora = performance.now(); E.tIni = agora; E.ultimoSom = agora;
  const querVoz = cfg.seguirVoz && reconhecimentoDisponivel() && navigator.onLine;
  if (querVoz) {
    E.rec = iniciarReconhecimento(E.seg, erro => { aviso('O reconhecimento de voz parou (' + erro + '). O texto vai seguir o seu ritmo médio.', 5200); E.seg.ritmo(true, performance.now()); E.rec = null; });
  }
  if (!E.rec) E.seg.ritmo(true, agora, cfg.wpm);
  E.estado = modo === 'gravar' ? 'gravando' : 'ensaio'; atualizarBotoes();
}
async function terminar(auto) {
  const E = Estudio; if (E.estado === 'parado') return;
  const estava = E.estado, bloco = E.bloco, parte = E.parte;
  E.ui.contagem.classList.remove('on'); if (E.rec) { E.rec.parar(); E.rec = null; }
  E.estado = 'parado'; atualizarBotoes(); Tela.soltar();
  if (estava === 'ensaio' || estava === 'contagem') { if (estava === 'contagem' && Mic.gravando) await Mic.terminar(); return; }
  aviso('Salvando…', 4000);
  const { pcm, video, mime } = await Mic.terminar();
  if (pcm.length < SR) { aviso('Gravação muito curta, não foi salva.'); return; }
  const i16 = new Int16Array(pcm.length); for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  const take = { parte: parte.id, bloco: chaveBloco(parte, bloco), ts: Date.now(), dur: pcm.length / SR, pcm: i16.buffer, video, mime, camera: video ? cfg.camera : 'off' };
  take.id = await BD.add(take); escolher(take.bloco, take.id);
  if (E.ui) { await listarBlocos(); await listarTakes(); }
  aviso(auto ? 'Trecho gravado! Você chegou ao fim do texto.' : 'Take salvo!');
  abrirTake(take);
}
function loop() {
  const E = Estudio, u = E.ui; if (!u || !E.seg) return;
  const agora = performance.now();
  let i = -1;
  if (E.estado === 'gravando' || E.estado === 'ensaio') {
    i = destaqueAtual(agora);
    u.rWpm.textContent = `${Math.round(E.seg.wpm)} pal./min`;
    if (E.estado === 'gravando') u.estadoRec.lastChild.textContent = `GRAVANDO ${fmt((agora - E.tIni) / 1000)}`;
    if (cfg.autoParar && E.seg.terminou() && agora - E.ultimoSom > 2000 && agora - E.tIni > 4000) terminar(true);
  } else if (E.estado === 'parado') u.rWpm.textContent = '';
  if (i !== E.destIdx) {
    const W = E.palavras, a = E.destIdx;
    if (a < -1 || Math.abs(i - a) > 300) W.forEach((w, k) => w.el.className = i < 0 ? 'w' : k < i ? 'w dito' : k === i ? 'w agora' : 'w');
    else if (i > a) { if (a >= 0) W[a].el.className = 'w dito'; for (let k = Math.max(0, a + 1); k < i; k++) W[k].el.className = 'w dito'; if (i >= 0) W[i].el.className = 'w agora'; }
    else { if (a >= 0) W[a].el.className = 'w'; for (let k = i + 1; k < a; k++) W[k].el.className = 'w'; if (i >= 0) W[i].el.className = 'w agora'; }
    E.destIdx = i; E.alvoEl = null;
  }
  const alvo = i >= 0 ? E.palavras[i].el : null;
  if (alvo && alvo !== E.alvoEl) {
    E.alvoEl = alvo;
    const H = u.miolo.clientHeight, y = alvo.offsetTop + alvo.offsetHeight / 2;
    u.tele.style.transform = `translate(-50%, ${Math.round(H * 0.40 - y)}px)`;
  }
}

/* ------------------------------------------------------------------ takes */
async function listarTakes() {
  const E = Estudio, el = E.ui.takesEl, k = chaveBloco(E.parte, E.bloco);
  const lista = (await BD.lista(k)).sort((a, b) => b.ts - a.ts), sel = escolhido(k);
  el.innerHTML = '';
  if (!lista.length) { el.append(h('p', { class: 'ajuda' }, 'Nenhuma gravação deste trecho ainda.')); return; }
  lista.forEach((t, n) => {
    const num = lista.length - n, d = new Date(t.ts), usa = t.id === sel || (!sel && n === 0);
    el.append(h('div', { class: 'take' + (usa ? ' sel' : '') },
      h('div', {}, h('b', {}, `Take ${num}`), h('br'), h('small', {}, `${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${fmt(t.dur)}${t.video ? ' · com imagem' : ' · só áudio'}`)),
      h('span', { class: 'selo ' + (usa ? 'ok' : '') }, usa ? '★ vai no pacote' : ''),
      h('div', { class: 'acoes' },
        h('button', { class: 'btn peq', onclick: () => abrirTake(t) }, 'Ver / ouvir'),
        h('button', { class: 'btn peq', onclick: () => { escolher(k, t.id); listarTakes(); } }, 'Usar este'),
        h('button', { class: 'btn peq fant', onclick: async () => { if (confirm('Excluir este take?')) { await BD.del(t.id); await listarTakes(); await listarBlocos(); } } }, 'Excluir'))));
  });
}
function desenharOnda(canvas, x) {
  const w = canvas.width = canvas.clientWidth * 2, hh = canvas.height = canvas.clientHeight * 2, g = canvas.getContext('2d');
  g.clearRect(0, 0, w, hh); g.fillStyle = '#4D8DFF'; const passo = Math.max(1, Math.floor(x.length / w));
  for (let i = 0; i < w; i++) { let m = 0; for (let k = i * passo; k < (i + 1) * passo && k < x.length; k++) m = Math.max(m, Math.abs(x[k])); const a = Math.max(1, m * hh * 0.95); g.fillRect(i, (hh - a) / 2, 1, a); }
}
async function abrirTake(take) {
  const d = $('#dlg'), E = Estudio; d.innerHTML = '';
  const t = await BD.get(take.id), x = int16ParaFloat(t.pcm), pico = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0), cnv = h('canvas', { class: 'onda' });
  let fonte = null, url = null;
  const parar_ = () => { try { fonte && fonte.stop(); } catch (e) {} fonte = null; };
  const ouvir = async () => {
    parar_(); const ctx = Mic.ctx || (window.__ctxPre = window.__ctxPre || new AudioContext({ sampleRate: SR })); await ctx.resume();
    const b = ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0); fonte = ctx.createBufferSource(); fonte.buffer = b; fonte.connect(ctx.destination); fonte.start();
  };
  const fechar = () => { parar_(); if (url) URL.revokeObjectURL(url); d.close(); };
  let midia;
  if (t.video) { url = URL.createObjectURL(t.video); midia = h('video', { class: 'rev', src: url, controls: '', playsinline: '' }); }
  d.append(h('h2', {}, 'Rever o take'), h('p', { class: 'ajuda' }, 'Confira a imagem e a leitura. Se não ficou como você quer, é só gravar de novo.'), midia || cnv,
    h('div', { class: 'resumo' }, h('div', {}, 'Duração', h('b', {}, fmt(x.length / SR))), h('div', {}, 'Pico de volume', h('b', {}, (20 * Math.log10(pico + 1e-9)).toFixed(1) + ' dB')), h('div', {}, 'Trecho', h('b', {}, (E.bloco ? E.bloco.titulo : '')))),
    h('div', { class: 'linha-btn' },
      t.video ? null : h('button', { class: 'btn prim', onclick: ouvir }, '▶ Ouvir'), t.video ? null : h('button', { class: 'btn fant', onclick: parar_ }, 'Parar'),
      h('button', { class: 'btn', onclick: () => { escolher(t.bloco, t.id); if (E.ui) listarTakes(); aviso('Este take vai no pacote.'); } }, 'Usar este take'),
      h('button', { class: 'btn fant', onclick: fechar }, 'Fechar')));
  d.onclose = () => { parar_(); if (url) { URL.revokeObjectURL(url); url = null; } };
  d.showModal(); if (!t.video) desenharOnda(cnv, x);
}
function dialogoVideo(parte) {
  const d = $('#dlg'); d.innerHTML = '';
  const v = h('video', { src: parte.video, controls: '', playsinline: '', class: 'rev' }); v.muted = true;
  d.append(h('h2', {}, `${parte.numero}. ${parte.titulo}`), h('p', { class: 'ajuda' }, 'Só para você ver a aula. As animações ainda estão no ritmo da voz-guia; depois de gravar, elas são ajustadas ao SEU ritmo.'), v,
    h('div', { class: 'linha-btn' }, h('button', { class: 'btn fant', onclick: () => { v.pause(); d.close(); } }, 'Fechar')));
  d.showModal();
}

/* ------------------------------------------------------------------ pacote para o alinhamento */
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
async function dialogoPacote(parteUnica) {
  const d = $('#dlg'); d.innerHTML = '';
  const escopo = parteUnica ? [parteUnica] : PARTES;
  const op = { norm: true, alvo: cfg.alvoLufs, hpf: cfg.hpf, nr: cfg.nr };
  const c = (k, tit, dica) => { const i = h('input', { type: 'checkbox' }); i.checked = !!op[k]; i.addEventListener('change', () => { op[k] = i.checked; if (k === 'hpf' || k === 'nr') { cfg[k] = i.checked; salvarCfg(); } }); return h('label', { class: 'chk' }, i, h('span', {}, tit, h('small', {}, dica))); };
  const tabela = h('div', { class: 'tab-pac' });
  let total = 0, prontos = 0, bytes = 0;
  for (const p of escopo) for (const b of p.blocos) {
    const t = await takeDoBloco(chaveBloco(p, b)); total++; if (t) { prontos++; bytes += t.video ? t.video.size : 0; }
    tabela.append(h('div', { class: 'lin' }, h('span', { class: 'ck ' + (t ? 'ok' : '') }, t ? '✓' : '○'), h('span', {}, `${p.numero}. ${b.titulo}`), h('small', {}, t ? fmt(t.dur) + (t.video ? ' · ' + mb(t.video.size) : '') : 'sem gravação')));
  }
  const saida = h('div', { class: 'ajuda' }, `${prontos} de ${total} trechos gravados${bytes ? ` · cerca de ${mb(bytes)} de vídeo` : ''}.`);
  const acoes = h('div', { class: 'linha-btn' });
  let arquivoZip = null;
  const montar = async () => {
    saida.textContent = 'Preparando os arquivos…'; await sleep(50);
    const arquivos = [], man = { criado: new Date().toISOString(),
      formato: 'MP4 original da câmera (imagem + som) por trecho, mais MP3 mono 48 kHz com volume nivelado',
      observacao: 'corte_inicio_s e corte_fim_s marcam onde a fala começa e termina dentro do MP4 (com folga de 0,3 s antes e 0,4 s depois). A gravação começa 3 s antes da fala, durante a contagem.',
      aulas: [] };
    let n = 0;
    for (const p of escopo) {
      const aula = { id: p.id, numero: p.numero, titulo: p.titulo, arquivo: p.arquivo, blocos: [] }; man.aulas.push(aula);
      let ib = 0;
      for (const b of p.blocos) {
        ib++; const take = await takeDoBloco(chaveBloco(p, b)); if (!take) continue;
        const r = processar(int16ParaFloat(take.pcm), op), mp3 = codificarMp3(r.x, 192);
        const base = `${p.arquivo}/${String(ib).padStart(2, '0')}_${b.id}_${slug(b.titulo)}`, nomeVid = take.video ? `${base}.${extDe(take.mime)}` : null;
        if (take.video) arquivos.push({ nome: nomeVid, blob: take.video });
        arquivos.push({ nome: `${base}_audio.mp3`, blob: mp3 }); n++;
        aula.blocos.push({ id: b.id, titulo: b.titulo, video: nomeVid, audio: `${base}_audio.mp3`, camera: take.camera || 'off',
          duracao_audio_s: +r.dur.toFixed(3), corte_inicio_s: +r.ini.toFixed(3), corte_fim_s: +r.fim.toFixed(3), duracao_gravada_s: +take.dur.toFixed(3),
          palavras: palavrasDoBloco(b), texto: b.paragrafos.join('\n'), depois: b.depois || '', gravado_em: new Date(take.ts).toISOString(),
          lufs_antes: +r.lufsAntes.toFixed(1), lufs_depois: +r.lufsDepois.toFixed(1) });
        saida.textContent = `Preparando… ${n}/${prontos}`; await sleep(10);
      }
    }
    if (!n) { saida.textContent = 'Ainda não há trechos gravados.'; return null; }
    arquivos.push({ nome: 'manifesto.json', dados: new TextEncoder().encode(JSON.stringify(man, null, 1)) });
    const blob = await criarZip(arquivos, (k, tot) => { saida.textContent = `Montando o ZIP… ${k}/${tot}`; });
    return { blob, n };
  };
  const nomeZip = () => `narracao_${parteUnica ? parteUnica.arquivo : 'aulas'}_${new Date().toISOString().slice(0, 10)}.zip`;
  const bBaixar = h('button', { class: 'btn prim', onclick: async () => {
    bBaixar.disabled = true;
    try {
      const r = await montar(); if (!r) return;
      arquivoZip = new File([r.blob], nomeZip(), { type: 'application/zip' });
      baixar(r.blob, arquivoZip.name);
      saida.textContent = `Pronto: ${r.n} trechos no ZIP (${mb(r.blob.size)}), salvo na pasta Downloads.`;
      if (navigator.canShare && navigator.canShare({ files: [arquivoZip] }) && !$('#btnCompartilhar', acoes))
        acoes.append(h('button', { class: 'btn', id: 'btnCompartilhar', onclick: () => navigator.share({ files: [arquivoZip], title: 'Narração das aulas' }).catch(() => {}) }, 'Compartilhar / enviar'));
    } catch (e) { console.error(e); saida.textContent = 'Não consegui montar o ZIP: ' + e.message + (bytes > 4e8 ? ' (muito vídeo de uma vez: baixe aula por aula)' : ''); }
    bBaixar.disabled = false;
  } }, '⬇ Baixar pacote (ZIP)');
  acoes.append(bBaixar, h('button', { class: 'btn fant', onclick: () => d.close() }, 'Fechar'));
  d.append(h('h2', {}, parteUnica ? `Pacote · ${parteUnica.titulo}` : 'Pacote de gravações'),
    h('p', { class: 'ajuda' }, 'Cada trecho vai em MP4 (a gravação com imagem e som) e também em um MP3 de áudio com o volume nivelado. O ZIP leva ainda o texto de cada trecho. Envie o ZIP de volta para ajustarmos as animações ao seu ritmo.'),
    tabela,
    c('norm', `Nivelar o volume do MP3 para ${op.alvo} LUFS`, 'Mesmo volume em todos os trechos.'),
    c('hpf', 'Cortar graves indesejados (80 Hz)', 'Tira ruído de mesa e vento.'),
    c('nr', 'Reduzir chiado entre as frases (leve)', 'Não afeta a voz.'),
    saida, acoes);
  d.showModal();
}

/* ------------------------------------------------------------------ início */
(async function () {
  await BD.abrir();
  telaPainel();
  window.__estudio = { Mic, BD, processar, aparar, limitesFala, codificarMp3, criarZip, lufs, cfg, Estudio, ir, Seguir, selecionarBloco, iniciarLeitura, terminar, dialogoPacote };   // para testes
})();
