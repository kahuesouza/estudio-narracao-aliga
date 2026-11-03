'use strict';
/* Interface: lista de trechos, teleprompter sobre a câmera (estilo Instagram) e pacote de gravações.
   O texto acompanha a voz pelo volume do microfone: anda enquanto o narrador fala e para quando ele para.
   Não usa reconhecimento de fala, então não disputa o microfone com a gravação (importante no celular). */

const Estudio = {
  parte: null, bloco: null, estado: 'parado', palavras: [], tokens: [], seg: null, destIdx: -2, alvoEl: null, raf: 0, ui: null,
  ultimoSom: 0, ultimaVoz: 0, tUlt: 0, tIni: 0, piso: [], limiar: 0.03,
  sair() {
    const E = this; cancelAnimationFrame(E.raf); document.removeEventListener('keydown', teclas);
    if (Mic.gravando) Mic.terminar();
    Tela.soltar(); document.body.classList.remove('gravando');
    E.estado = 'parado'; E.parte = E.bloco = E.seg = E.ui = null;
  },
};
const estimativa = b => Math.round(palavrasDoBloco(b) / cfg.wpm * 60);

/* ------------------------------------------------------------------ câmera e microfone */
let abrindoMic = null;
function ligarMic() {
  if (abrindoMic) return abrindoMic;
  abrindoMic = (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { aviso('Este navegador não libera câmera e microfone aqui. Use o Chrome ou o Safari pelo link seguro (https).', 7000); return false; }
    try {
      await Mic.ligar();
      if (Mic.semCamera) aviso('Não consegui abrir a câmera. Vou gravar só o áudio; confira a permissão da câmera.', 6000);
      return true;
    } catch (e) {
      aviso(e.name === 'NotAllowedError' ? 'O navegador bloqueou o acesso. Toque no cadeado da barra de endereço e permita câmera e microfone.' : 'Não consegui abrir o microfone: ' + e.message, 7000);
      return false;
    }
  })().finally(() => { abrindoMic = null; });
  return abrindoMic;
}
function ir(tela, id, blocoId) {
  Estudio.sair();
  tela === 'estudio' ? telaEstudio(PARTES.find(p => p.id === id), blocoId) : telaPainel();
}

/* ------------------------------------------------------------------ ajustes */
function interruptor(chave, titulo, dica, aoMudar) {
  const i = h('input', { type: 'checkbox' }); i.checked = !!cfg[chave];
  i.addEventListener('change', () => { cfg[chave] = i.checked; salvarCfg(); if (aoMudar) aoMudar(); });
  return h('label', { class: 'opc' }, h('span', {}, titulo, dica ? h('small', {}, dica) : null), i);
}
function dialogoAjustes() {
  const d = $('#dlg'), E = Estudio; d.innerHTML = '';
  const parado = E.estado === 'parado';
  const seg = h('div', { class: 'seg' });
  const pintar = () => $$('button', seg).forEach(b => b.classList.toggle('sel', b.dataset.v === cfg.camera));
  for (const [v, t] of [['user', 'Frontal'], ['environment', 'Traseira'], ['off', 'Sem imagem']])
    seg.append(h('button', { 'data-v': v, onclick: async () => { if (!parado) return; cfg.camera = v; salvarCfg(); pintar(); if (Mic.ligado) { await ligarMic(); } else atualizarPrevias(); } }, t));
  pintar();
  const sel = h('select', {}, h('option', { value: '' }, 'Microfone padrão'));
  listarMics(sel); sel.addEventListener('change', () => { cfg.dev = sel.value; salvarCfg(); if (Mic.ligado) ligarMic(); });
  d.append(h('h2', {}, 'Ajustes'),
    h('div', { class: 'grupo' }, h('label', {}, 'Câmera'), seg, parado ? null : h('small', { class: 'dica' }, 'Troque a câmera antes de gravar.')),
    h('div', { class: 'grupo' }, h('label', {}, 'Microfone'), sel),
    interruptor('autoParar', 'Parar sozinho ao terminar', 'Encerra depois do fim do texto, quando você fica em silêncio.'),
    interruptor('espelho', 'Espelhar o texto', 'Só para teleprompter de vidro.', () => { if (E.ui) E.ui.tele.classList.toggle('espelho', cfg.espelho); }),
    interruptor('ruido', 'Reduzir ruído do ambiente', 'Ajuda contra ventilador e ar-condicionado.'),
    h('div', { class: 'acoes' }, h('button', { class: 'btn', onclick: () => d.close() }, 'Pronto')));
  d.showModal();
}
async function listarMics(sel) {
  try {
    const l = await navigator.mediaDevices.enumerateDevices();
    l.filter(x => x.kind === 'audioinput' && x.deviceId && !['default', 'communications'].includes(x.deviceId)).forEach(x => sel.append(h('option', { value: x.deviceId }, x.label || 'Microfone')));
    sel.value = cfg.dev;
  } catch (e) {}
}

/* ------------------------------------------------------------------ lista de trechos */
async function telaPainel() {
  const raiz = $('#tela'); raiz.innerHTML = '';
  const pg = h('div', { class: 'pagina' });
  let total = 0, feitos = 0;
  const aulas = [];
  for (const p of PARTES) {
    const linhas = [];
    for (const b of p.blocos) {
      const t = await takeDoBloco(chaveBloco(p, b)); total++; if (t) feitos++;
      linhas.push(h('button', { class: 'linha', onclick: () => { ligarMic(); ir('estudio', p.id, b.id); } },
        h('span', { class: 'ck' + (t ? ' ok' : '') }, t ? '✓' : ''),
        h('span', { class: 't' }, b.titulo, h('small', {}, t ? `Gravado · ${fmt(t.dur)}` : `${palavrasDoBloco(b)} palavras · cerca de ${fmt(estimativa(b))}`)),
        h('span', { class: 'seta' }, '›')));
    }
    aulas.push(h('section', { class: 'aula' }, h('h2', {}, `${rotuloParte(p)} · ${p.titulo}`), linhas));
  }
  pg.append(
    h('header', { class: 'cab' },
      h('div', {}, h('h1', {}, 'Narração'), h('p', { class: 'sub' }, 'A Liga · CVDentus')),
      h('button', { class: 'link', onclick: dialogoAjustes }, 'Ajustes')),
    h('p', { class: 'intro' }, 'Toque em um trecho e leia. O texto rola sozinho; ajuste a velocidade e o tamanho no cartão do texto.'),
    ...aulas);
  raiz.append(pg, h('div', { class: 'rodape-fixo' }, h('button', { class: 'btn largo', disabled: feitos ? null : '', onclick: () => dialogoPacote() }, feitos ? `Enviar gravações · ${feitos} de ${total}` : 'Nenhum trecho gravado ainda')));
}

/* ------------------------------------------------------------------ teleprompter */
async function telaEstudio(parte, blocoId) {
  const E = Estudio; E.parte = parte;
  const raiz = $('#tela'); raiz.innerHTML = '';
  const tele = h('div', { class: 'tele' }); tele.style.fontSize = cfg.fonte + 'px'; tele.classList.toggle('espelho', cfg.espelho);
  const miolo = h('div', { class: 'tele-miolo' }, tele);
  const previa = h('video', { class: 'previa off', playsinline: '', autoplay: '', muted: '' });
  const titulo = h('div', { class: 'tit-trecho' });
  const bAnt = h('button', { class: 'chip so-ico', 'aria-label': 'Trecho anterior', onclick: () => vizinho(-1) }, '‹');
  const bProx = h('button', { class: 'chip so-ico', 'aria-label': 'Próximo trecho', onclick: () => vizinho(1) }, '›');
  const tempo = h('div', { class: 'chip tempo-rec' }, h('i'), h('span', {}, '0:00'));
  const contagem = h('div', { class: 'contagem' }, h('span', {}, '3'), h('small', {}, 'Respire e comece a ler'));
  const bRec = h('button', { class: 'rec', 'aria-label': 'Gravar', onclick: () => (E.estado === 'parado' ? iniciarLeitura('gravar') : terminar()) }, h('i'));
  const bVirar = h('button', { class: 'lat', onclick: async () => {
    if (E.estado !== 'parado') return;
    cfg.camera = cfg.camera === 'user' ? 'environment' : 'user'; salvarCfg(); await ligarMic();
  } }, h('span', { class: 'ico' }, '⟲'), 'Virar');
  const bRever = h('button', { class: 'lat', onclick: async () => { const t = await takeDoBloco(chaveBloco(E.parte, E.bloco)); if (t) abrirTake(t); } }, h('span', { class: 'ico' }, '▶'), 'Rever');
  const topo = h('div', { class: 'topo-est' },
    h('button', { class: 'chip', onclick: () => ir('painel'), 'aria-label': 'Voltar aos trechos' }, '←'),
    h('div', { class: 'meio' }, bAnt, titulo, bProx),
    h('button', { class: 'chip', onclick: dialogoAjustes }, 'Ajustes'));
  const ico = svg => h('span', { class: 'ico-svg', html: svg });
  const vel = h('input', { type: 'range', min: 60, max: 260, step: 5, value: cfg.wpm, 'aria-label': 'Velocidade do teleprompter' });
  vel.addEventListener('input', () => { cfg.wpm = +vel.value; salvarCfg(); if (E.seg) E.seg.ajustarWpm(cfg.wpm, performance.now()); });
  const tam = h('input', { type: 'range', min: 18, max: 48, step: 1, value: Math.max(18, Math.min(48, cfg.fonte)), 'aria-label': 'Tamanho do texto' });
  tam.addEventListener('input', () => { cfg.fonte = +tam.value; tele.style.fontSize = cfg.fonte + 'px'; salvarCfg(); E.alvoEl = null; if (E.estado === 'parado') resetarPosicao(); });
  const pop = h('div', { class: 'pop-tele' }, h('label', {}, 'Velocidade do teleprompter'), vel, h('label', {}, 'Tamanho do texto'), tam);
  const cena = h('div', { class: 'cena' }, previa, topo, tempo);
  const bX = h('button', { class: 'tele-ico tele-x', 'aria-label': 'Fechar o texto', onclick: () => { pop.classList.remove('on'); cena.classList.add('sem-tele'); } }, ico('<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'));
  const bAj = h('button', { class: 'tele-ico tele-aj', 'aria-label': 'Velocidade e tamanho do texto', onclick: () => pop.classList.toggle('on') }, ico('<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 7h9M18 7h3M3 17h4M13 17h8"/><circle cx="15" cy="7" r="2.6"/><circle cx="10" cy="17" r="2.6"/></svg>'));
  const bTam = h('div', { class: 'tele-ico tele-tam', role: 'separator', 'aria-label': 'Arraste para mudar a altura do quadro' }, ico('<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 9L9 20M20 15l-5 5"/></svg>'));
  const cartao = h('div', { class: 'cartao-tele' }, miolo, bX, bAj, bTam, pop);
  if (cfg.altCartao) cartao.style.setProperty('--alt-cartao', cfg.altCartao + 'px');
  bTam.addEventListener('pointerdown', ev => {
    ev.preventDefault(); bTam.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, h0 = cartao.offsetHeight;
    const mv = e2 => { const alt = Math.round(Math.max(110, Math.min(innerHeight * 0.7, h0 + e2.clientY - y0))); cartao.style.setProperty('--alt-cartao', alt + 'px'); cfg.altCartao = alt; E.alvoEl = null; if (E.estado === 'parado') resetarPosicao(); };
    const fim = () => { bTam.removeEventListener('pointermove', mv); bTam.removeEventListener('pointerup', fim); bTam.removeEventListener('pointercancel', fim); salvarCfg(); };
    bTam.addEventListener('pointermove', mv); bTam.addEventListener('pointerup', fim); bTam.addEventListener('pointercancel', fim);
  });
  cena.addEventListener('pointerdown', ev => { if (!pop.contains(ev.target) && !bAj.contains(ev.target)) pop.classList.remove('on'); });
  cena.append(cartao, h('button', { class: 'chip mostrar-tele', onclick: () => cena.classList.remove('sem-tele') }, 'Mostrar texto'),
    contagem,
    h('div', { class: 'rodape' }, bVirar, bRec, bRever));
  raiz.append(cena);
  E.ui = { tele, miolo, titulo, bAnt, bProx, bRec, bVirar, bRever, tempo, contagem, previa };
  document.addEventListener('keydown', teclas);
  const f = () => { loop(); E.raf = requestAnimationFrame(f); }; E.tUlt = performance.now(); f();
  atualizarPrevias();
  await selecionarBloco(blocoId || parte.blocos[0].id);
}
async function selecionarBloco(id) {
  const E = Estudio; E.bloco = E.parte.blocos.find(b => b.id === id) || E.parte.blocos[0];
  const i = E.parte.blocos.indexOf(E.bloco);
  E.ui.titulo.innerHTML = ''; E.ui.titulo.append(h('b', {}, E.bloco.titulo), h('small', {}, `Trecho ${i + 1} de ${E.parte.blocos.length} · ${rotuloParte(E.parte)}`));
  E.ui.bAnt.disabled = i === 0; E.ui.bProx.disabled = i === E.parte.blocos.length - 1;
  montarTele(E.bloco); resetarPosicao(); await atualizarRever();
}
function vizinho(d) {
  const E = Estudio; if (E.estado !== 'parado') return;
  const i = E.parte.blocos.indexOf(E.bloco) + d; if (i >= 0 && i < E.parte.blocos.length) selecionarBloco(E.parte.blocos[i].id);
}
async function atualizarRever() { const E = Estudio; if (!E.ui) return; const t = await takeDoBloco(chaveBloco(E.parte, E.bloco)); E.ui.bRever.disabled = !t; E.ui.bRever.classList.toggle('ok', !!t); }
function montarTele(bloco) {
  const E = Estudio, tele = E.ui.tele; tele.innerHTML = ''; E.palavras = [];
  const tokens = []; let nTok = 0;
  const addPalavra = (w, p) => {
    const tk = Seguir.tokenizar(w), sp = h('span', { class: 'w' }, w), i = E.palavras.length;
    sp.addEventListener('click', () => { if (E.estado !== 'parado' && E.seg) E.seg.definir(E.palavras[i].ini, performance.now()); });
    p.append(sp, ' '); E.palavras.push({ el: sp, ini: nTok }); tk.forEach(t => tokens.push(t)); nTok += tk.length;
  };
  bloco.paragrafos.forEach((par, k) => {
    if (k > 0) tele.append(h('div', { class: 'nota' }, 'Pausa curta · respire'));
    for (const sen of par.split(/(?<=[.!?])\s+/)) {
      const p = h('p', { class: 'frase' }); sen.split(/\s+/).filter(Boolean).forEach(w => addPalavra(w, p)); tele.append(p);
    }
  });
  tele.append(h('div', { class: 'nota fim' }, bloco.depois ? `Fim do trecho · ${bloco.depois}` : 'Fim do trecho'));
  E.tokens = tokens; E.seg = Seguir.criar(tokens, { wpm: cfg.wpm });
}
function resetarPosicao() {
  const E = Estudio; if (!E.bloco) return;
  E.seg = Seguir.criar(E.tokens, { wpm: cfg.wpm }); E.destIdx = -2; E.alvoEl = null;
  E.palavras.forEach(w => w.el.className = 'w');
  E.ui.tele.style.transform = `translate(-50%, ${Math.round(E.ui.miolo.clientHeight * 0.34)}px)`;
}
function teclas(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('#dlg').open) return;
  if (e.code === 'Space') { e.preventDefault(); Estudio.estado === 'parado' ? iniciarLeitura('gravar') : terminar(); }
}
function destaqueAtual(agora) {
  const E = Estudio, t = E.seg.visivel(agora); let lo = 0, hi = E.palavras.length - 1, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (E.palavras[m].ini <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
async function iniciarLeitura(modo) {
  const E = Estudio; if (E.estado !== 'parado') return;
  if (modo === 'gravar' && !Mic.ligado && !(await ligarMic())) return;
  if (!Mic.ligado) return;
  resetarPosicao(); E.estado = 'contagem'; E.piso = []; atualizarEstado(); Tela.ligar();
  if (modo === 'gravar') Mic.comecar();                       // já na contagem; o começo é aparado na exportação
  const c = E.ui.contagem; c.classList.add('on');
  for (let n = 3; n >= 1 && E.estado === 'contagem'; n--) { $('span', c).textContent = n; await sleep(1000); }
  c.classList.remove('on'); if (E.estado !== 'contagem') return;
  const agora = performance.now(), o = E.piso.sort((a, b) => a - b), mediana = o.length ? o[o.length >> 1] : 0.005;
  E.limiar = Math.max(0.03, mediana * 3);                    // o que passar disso é voz
  E.tIni = agora; E.ultimoSom = agora; E.ultimaVoz = 0; E.tUlt = agora;
  E.seg.ritmo(true, agora, cfg.wpm);                          // o relógio do texto só anda enquanto há voz
  E.estado = modo === 'gravar' ? 'gravando' : 'ensaio'; E.modo = modo; atualizarEstado();
}
function atualizarEstado() {
  const E = Estudio, u = E.ui; if (!u) return;
  const ativo = E.estado !== 'parado';
  document.body.classList.toggle('gravando', ativo);
  u.bRec.classList.toggle('on', ativo); u.bVirar.disabled = ativo;
  u.bRec.setAttribute('aria-label', ativo ? 'Parar' : 'Gravar');
}
async function terminar(auto) {
  const E = Estudio; if (E.estado === 'parado') return;
  const estava = E.estado, bloco = E.bloco, parte = E.parte;
  E.ui.contagem.classList.remove('on');
  E.estado = 'parado'; atualizarEstado(); Tela.soltar();
  if (estava === 'ensaio' || estava === 'contagem') { if (Mic.gravando) await Mic.terminar(); return; }
  aviso('Salvando…', 4000);
  const { pcm, video, mime } = await Mic.terminar();
  if (pcm.length < SR) { aviso('Gravação muito curta, não foi salva.'); return; }
  const i16 = new Int16Array(pcm.length); for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  const take = { parte: parte.id, bloco: chaveBloco(parte, bloco), ts: Date.now(), dur: pcm.length / SR, pcm: i16.buffer, video, mime, camera: video ? cfg.camera : 'off' };
  take.id = await BD.add(take); escolher(take.bloco, take.id);
  if (E.ui) await atualizarRever();
  abrirTake(take, true);
}
function loop() {
  const E = Estudio, u = E.ui; if (!u || !E.seg) return;
  const agora = performance.now(), dt = agora - E.tUlt; E.tUlt = agora;
  const n = Mic.nivel();
  if (E.estado === 'contagem') E.piso.push(n);
  let i = -1;
  if (E.estado === 'gravando' || E.estado === 'ensaio') {
    if (n > E.limiar) E.ultimaVoz = agora;
    i = destaqueAtual(agora);
    if (E.estado === 'gravando') $('span', u.tempo).textContent = fmt((agora - E.tIni) / 1000);
    const silencio = agora - E.ultimaVoz, perto = E.seg.pos >= E.tokens.length * 0.85;
    if (cfg.autoParar && agora - E.tIni > 4000 && E.ultimaVoz && ((E.seg.terminou() && silencio > 2000) || (perto && silencio > 3500))) terminar(true);
  }
  if (i !== E.destIdx) {
    const W = E.palavras, a = E.destIdx;
    if (a < -1 || Math.abs(i - a) > 300) W.forEach((w, k) => w.el.className = i < 0 ? 'w' : k < i ? 'w dito' : k === i ? 'w agora' : 'w');
    else if (i > a) { if (a >= 0) W[a].el.className = 'w dito'; for (let k = Math.max(0, a + 1); k < i; k++) W[k].el.className = 'w dito'; if (i >= 0) W[i].el.className = 'w agora'; }
    else { if (a >= 0) W[a].el.className = 'w'; for (let k = i + 1; k < a; k++) W[k].el.className = 'w'; if (i >= 0) W[i].el.className = 'w agora'; }
    E.destIdx = i; E.alvoEl = null;
  }
  if (i >= 0) {                                              // rolagem automática contínua: desliza entre uma palavra e a seguinte
    const W = E.palavras, w0 = W[i], w1 = W[Math.min(i + 1, W.length - 1)];
    const p = Math.max(0, (agora - E.seg.t0) * E.seg.wpm / 60000), vao = w1.ini - w0.ini;
    const f = vao > 0 ? Math.max(0, Math.min(1, (p - w0.ini) / vao)) : 0;
    const y0 = w0.el.offsetTop + w0.el.offsetHeight / 2, y1 = w1.el.offsetTop + w1.el.offsetHeight / 2;
    u.tele.style.transform = `translate(-50%, ${(u.miolo.clientHeight * 0.34 - (y0 + (y1 - y0) * f)).toFixed(1)}px)`;
  }
}

/* ------------------------------------------------------------------ rever o take */
function desenharOnda(canvas, x) {
  const w = canvas.width = canvas.clientWidth * 2, hh = canvas.height = canvas.clientHeight * 2, g = canvas.getContext('2d');
  g.clearRect(0, 0, w, hh); g.fillStyle = '#2563eb'; const passo = Math.max(1, Math.floor(x.length / w));
  for (let i = 0; i < w; i++) { let m = 0; for (let k = i * passo; k < (i + 1) * passo && k < x.length; k++) m = Math.max(m, Math.abs(x[k])); const a = Math.max(1, m * hh * 0.95); g.fillRect(i, (hh - a) / 2, 1, a); }
}
async function abrirTake(take, recem) {
  const d = $('#dlg'), E = Estudio; d.innerHTML = '';
  const t = await BD.get(take.id), x = int16ParaFloat(t.pcm), cnv = h('canvas', { class: 'onda' });
  let fonte = null, url = null;
  const parar_ = () => { try { fonte && fonte.stop(); } catch (e) {} fonte = null; };
  const ouvir = async () => {
    parar_(); const ctx = Mic.ctx || (window.__ctxPre = window.__ctxPre || new AudioContext({ sampleRate: SR })); await ctx.resume();
    const b = ctx.createBuffer(1, x.length, SR); b.copyToChannel(x, 0); fonte = ctx.createBufferSource(); fonte.buffer = b; fonte.connect(ctx.destination); fonte.start();
  };
  let midia;
  if (t.video) { url = URL.createObjectURL(t.video); midia = h('video', { class: 'rev', src: url, controls: '', playsinline: '' }); }
  d.onclose = () => { parar_(); if (url) { URL.revokeObjectURL(url); url = null; } };
  d.append(h('h2', {}, recem ? 'Gravado! Confira' : 'Rever'), h('p', { class: 'dica' }, `${E.bloco ? E.bloco.titulo : ''} · ${fmt(x.length / SR)}`), midia || cnv,
    h('div', { class: 'acoes' },
      t.video ? null : h('button', { class: 'btn sec', onclick: ouvir }, '▶ Ouvir'),
      h('button', { class: 'btn sec', onclick: async () => { if (confirm('Descartar esta gravação?')) { await BD.del(t.id); d.close(); if (E.ui) await atualizarRever(); else telaPainel(); } } }, 'Descartar'),
      h('button', { class: 'btn', onclick: () => d.close() }, recem ? 'Está bom' : 'Fechar')));
  d.showModal(); if (!t.video) desenharOnda(cnv, x);
}

/* ------------------------------------------------------------------ pacote de gravações */
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
async function montarZip(escopo, saida) {
  const op = { norm: true, alvo: cfg.alvoLufs, hpf: cfg.hpf, nr: cfg.nr };
  const arquivos = [], man = { criado: new Date().toISOString(),
    formato: 'MP4 original da câmera (imagem + som) por trecho, mais MP3 mono 48 kHz com volume nivelado',
    observacao: 'corte_inicio_s e corte_fim_s marcam onde a fala começa e termina dentro do MP4 (com folga de 0,3 s antes e 0,4 s depois). A gravação começa 3 s antes da fala, durante a contagem.', aulas: [] };
  let n = 0, prontos = 0;
  for (const p of escopo) for (const b of p.blocos) if (await takeDoBloco(chaveBloco(p, b))) prontos++;
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
  const blob = await criarZip(arquivos, (k, tot) => { saida.textContent = `Montando o arquivo… ${k}/${tot}`; });
  return { blob, n };
}
async function dialogoPacote(parteUnica) {
  const d = $('#dlg'); d.innerHTML = '';
  const saida = h('p', { class: 'dica' }, 'Cada trecho vai em MP4 (imagem e som) e MP3 (áudio nivelado), com um arquivo de texto e tempos.');
  const compartilhar = h('div', { class: 'acoes' });
  const lista = h('div', { class: 'lista-pac' });
  const baixarEscopo = async (escopo, nome, botao) => {
    botao.disabled = true;
    try {
      const r = await montarZip(escopo, saida); if (!r) return;
      const arq = new File([r.blob], `narracao_${nome}_${new Date().toISOString().slice(0, 10)}.zip`, { type: 'application/zip' });
      baixar(r.blob, arq.name);
      saida.textContent = `Pronto: ${r.n} ${r.n > 1 ? "trechos" : "trecho"} (${mb(r.blob.size)}). O arquivo foi salvo em Downloads.`;
      compartilhar.innerHTML = '';
      const texto = 'Gravações da narração - A Liga (CVDentus)';
      if (navigator.canShare && navigator.canShare({ files: [arq] })) {
        // a folha de compartilhamento do aparelho lista o WhatsApp; precisa de um toque novo, por isso o botão aparece só depois do arquivo pronto
        compartilhar.append(
          h('button', { class: 'btn zap', onclick: () => navigator.share({ files: [arq], title: texto, text: texto }).catch(() => {}) }, 'Enviar pelo WhatsApp'),
          h('small', { class: 'dica' }, 'Na lista que abrir, escolha WhatsApp e o contato. Outros aplicativos também aparecem ali.'));
      } else {
        compartilhar.append(
          h('button', { class: 'btn zap', onclick: () => window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener') }, 'Abrir WhatsApp'),
          h('small', { class: 'dica' }, 'Este navegador não envia arquivos direto. Abra a conversa e anexe o arquivo salvo em Downloads (clipe, Documento).'));
      }
    } catch (e) { console.error(e); saida.textContent = 'Não consegui montar o arquivo: ' + e.message + '. Tente baixar uma aula por vez.'; }
    botao.disabled = false;
  };
  let tudo = 0;
  for (const p of (parteUnica ? [parteUnica] : PARTES)) {
    let n = 0, bytes = 0;
    for (const b of p.blocos) { const t = await takeDoBloco(chaveBloco(p, b)); if (t) { n++; bytes += t.video ? t.video.size : 0; } }
    tudo += n;
    const bt = h('button', { class: 'btn sec', disabled: n ? null : '' }, 'Baixar'); bt.onclick = () => baixarEscopo([p], p.arquivo, bt);
    lista.append(h('div', { class: 'item-pac' }, h('span', { class: 't' }, `${rotuloParte(p)} · ${p.titulo}`, h('small', {}, `${n} de ${p.blocos.length} trechos${bytes ? ' · ' + mb(bytes) : ''}`)), bt));
  }
  const bTudo = h('button', { class: 'btn', disabled: tudo ? null : '' }, 'Baixar tudo em um arquivo'); bTudo.onclick = () => baixarEscopo(parteUnica ? [parteUnica] : PARTES, parteUnica ? parteUnica.arquivo : 'aulas', bTudo);
  d.append(h('h2', {}, 'Enviar gravações'), lista, saida, compartilhar, h('div', { class: 'acoes' }, bTudo, h('button', { class: 'btn sec', onclick: () => d.close() }, 'Fechar')));
  d.showModal();
}

/* ------------------------------------------------------------------ início */
(async function () {
  await BD.abrir();
  telaPainel();
  window.__estudio = { Mic, BD, processar, limitesFala, codificarMp3, criarZip, lufs, cfg, Estudio, ir, Seguir, selecionarBloco, iniciarLeitura, terminar, dialogoPacote, dialogoAjustes, ligarMic };   // para testes
})();
