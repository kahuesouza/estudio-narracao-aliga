'use strict';
/* Estúdio de Narração · A Liga  (motor: microfone, câmera, áudio, ZIP; a interface está em ui.js)
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
const PADRAO = { eco: false, ruido: true, agc: false, dev: '', fonte: celular ? 30 : 38, espelho: false, wpm: 150, autoParar: true,
                 camera: 'user', alvoLufs: -16, hpf: true, nr: true };
let cfg = { ...PADRAO };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('estudio-cfg4') || '{}')); } catch (e) {}
const salvarCfg = () => { try { localStorage.setItem('estudio-cfg4', JSON.stringify(cfg)); } catch (e) {} };
const aviso = (t, ms = 3200) => { const a = $('#aviso'); a.textContent = t; a.classList.add('on'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('on'), ms); };
/* sufixo muda quando o roteiro muda, para não reaproveitar gravações de textos antigos */
const VERSAO_ROTEIRO = 'r2';
const chaveBloco = (parte, bloco) => `${parte.id}/${bloco.id}@${VERSAO_ROTEIRO}`;
const rotuloParte = p => p.numero ? `Aula ${p.numero}` : 'Abertura';
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
    $$('.medidor i').forEach(i => i.style.transform = `scaleX(${pct / 100})`);
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

