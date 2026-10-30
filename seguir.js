'use strict';
/* Motor que acompanha a leitura do narrador.
   Duas fontes de posição, usadas juntas:
   1) reconhecimento de fala (o que o navegador ouviu é comparado com o roteiro, palavra por palavra);
   2) ritmo: estimativa de palavras por minuto do próprio narrador, que "empurra" o destaque entre uma
      confirmação e outra e, sem reconhecimento, conduz o texto sozinho.
   Funciona no navegador (window.Seguir) e no Node (para testes). */
(function (raiz) {
  const UN = ['zero', 'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const CEN = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  function extenso(n) {
    if (n < 20) return UN[n];
    if (n < 100) { const d = Math.floor(n / 10), u = n % 10; return DEZ[d] + (u ? ' e ' + UN[u] : ''); }
    if (n === 100) return 'cem';
    if (n < 1000) { const c = Math.floor(n / 100), r = n % 100; return CEN[c] + (r ? ' e ' + extenso(r) : ''); }
    if (n < 1000000) { const m = Math.floor(n / 1000), r = n % 1000; return (m === 1 ? 'mil' : extenso(m) + ' mil') + (r ? (r < 100 || r % 100 === 0 ? ' e ' : ' ') + extenso(r) : ''); }
    return String(n);
  }
  const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  function tokenizar(texto) {
    let t = String(texto).toLowerCase().replace(/\d{1,3}(?:\.\d{3})+|\d+/g, m => extenso(parseInt(m.replace(/\./g, ''), 10)));
    t = semAcento(t).replace(/[^a-z0-9]+/g, ' ').trim();
    return t ? t.split(' ') : [];
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function casa(h, s) {
    if (h === s) return true;
    if (h.length < 4 || s.length < 4) return false;
    if (h[0] !== s[0]) return false;
    return 1 - lev(h, s) / Math.max(h.length, s.length) >= 0.72;
  }
  /* Avança a partir de `base` com as palavras ouvidas. Devolve a próxima palavra esperada (pos). */
  function avancar(script, base, hip, janela = 7) {
    let j = base;
    for (const h of hip) {
      let achou = -1;
      for (let k = j; k < Math.min(script.length, j + janela); k++) if (casa(h, script[k])) { achou = k; break; }
      if (achou < 0) continue;
      if (h.length <= 2 && achou - j > 2) continue;       // palavrinhas (a, o, e, de) só valem coladas na posição
      j = achou + 1;
    }
    return j;
  }
  /* Se o narrador pulou ou voltou muito, procura 3 palavras seguidas em uma janela maior
     e segue dali, aproveitando o resto do que foi ouvido. */
  function reencontrar(script, pos, hip, janela = 70) {
    for (let i = 0; i + 2 < hip.length; i++) {
      for (let k = Math.max(0, pos - 20); k < Math.min(script.length - 2, pos + janela); k++) {
        if (script[k] === hip[i] && script[k + 1] === hip[i + 1] && script[k + 2] === hip[i + 2]) return avancar(script, k + 3, hip.slice(i + 3));
      }
    }
    return -1;
  }

  function criar(texto, opc = {}) {
    const tokens = Array.isArray(texto) ? texto : tokenizar(texto);
    const S = {
      tokens, pos: 0, base: 0, resultadoAtual: -1, marcas: [], wpm: opc.wpm || 150, tConf: 0, modoRitmo: false, t0: 0, fim: tokens.length,
    };
    const registrar = agora => {
      S.marcas.push({ t: agora, n: S.pos });
      while (S.marcas.length > 2 && agora - S.marcas[0].t > 14000) S.marcas.shift();
      const a = S.marcas[0], b = S.marcas[S.marcas.length - 1];
      if (b.n - a.n >= 5 && b.t - a.t >= 2000) {
        const w = (b.n - a.n) / ((b.t - a.t) / 60000);
        S.wpm = Math.max(80, Math.min(240, S.wpm * 0.6 + w * 0.4));
      }
    };
    /* Resultado do reconhecedor: `i` = índice do trecho; `agora` em ms. */
    S.hipotese = function (i, texto, final, agora) {
      if (i !== S.resultadoAtual) { S.base = S.pos; S.resultadoAtual = i; }
      const hip = tokenizar(texto); if (!hip.length) return S.pos;
      let np = avancar(tokens, S.base, hip);
      if (np <= S.pos) { const r = reencontrar(tokens, S.pos, hip); if (r >= 0 && r > S.pos) np = r; }
      if (np > S.pos) { S.pos = Math.min(np, tokens.length); S.tConf = agora; registrar(agora); }
      return S.pos;
    };
    S.definir = function (i, agora) {
      S.pos = Math.max(0, Math.min(i, tokens.length)); S.base = S.pos; S.tConf = agora; S.marcas = [];
      if (S.modoRitmo) S.t0 = agora - S.pos / (S.wpm / 60000);
    };
    S.ritmo = function (ligar, agora, wpm) {
      S.modoRitmo = ligar; if (wpm) S.wpm = wpm;
      if (ligar) S.t0 = agora - S.pos / (S.wpm / 60000);
    };
    S.ajustarWpm = function (wpm, agora) {
      const atual = S.visivel(agora); S.wpm = Math.max(60, Math.min(260, wpm));
      if (S.modoRitmo) S.t0 = agora - atual / (S.wpm / 60000);
    };
    /* Palavra que o narrador deve estar dizendo agora (índice). */
    S.visivel = function (agora) {
      let p;
      if (S.modoRitmo) { p = (agora - S.t0) * S.wpm / 60000; S.pos = Math.max(S.pos, Math.min(tokens.length, Math.floor(p))); }
      else p = S.pos + Math.max(0, Math.min(2.2, (agora - S.tConf) * S.wpm / 60000));
      return Math.max(0, Math.min(tokens.length - 1, Math.floor(p)));
    };
    S.terminou = () => S.pos >= tokens.length - 1;
    return S;
  }
  const API = { criar, tokenizar, avancar, reencontrar, extenso, casa };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else raiz.Seguir = API;
})(typeof window !== 'undefined' ? window : globalThis);
