# Narração · A Liga

Aplicativo para narrar as 3 aulas da CVDentus para a A Liga Dental Education **no ritmo do próprio narrador**, com visual branco e simples: câmera em tela cheia e o texto num cartão por cima, como o teleprompter do Instagram. Funciona no celular e no computador.

**Abrir:** https://kahuesouza.github.io/estudio-narracao-aliga/ (Chrome, Edge ou Safari; permita câmera e microfone)

## Como usar

1. Toque em um trecho da lista. A câmera abre sozinha (use **Virar** para trocar entre frontal e traseira).
2. Toque no botão vermelho. Depois de 3 segundos, leia no seu ritmo.
3. Toque no quadrado vermelho para parar (ou termine a leitura: ele encerra sozinho). Confira o vídeo e toque em **Está bom**.
4. Na lista, **Enviar gravações** baixa o ZIP (ou compartilha direto, no celular).

## Como o texto acompanha a voz

O texto anda **enquanto você fala e para quando você para**, medindo o volume do microfone. Não usa reconhecimento de fala, por isso não disputa o microfone com a gravação, não precisa de internet e funciona igual no celular. A velocidade (palavras por minuto) é ajustável em **Ajustes**; toque numa palavra para voltar ao ponto certo.

## O que vai no ZIP

- `NN_trecho.mp4` — gravação original com imagem e som (H.264 + AAC no Chrome e Safari; WebM no Firefox).
- `NN_trecho_audio.mp3` — áudio mono 48 kHz, volume nivelado em −16 LUFS, silêncio do começo e do fim aparado.
- `manifesto.json` — texto, duração e onde a fala começa e termina em cada trecho (base para alinhar as animações).

## Observações

- As gravações ficam salvas só no navegador do aparelho. Baixe o ZIP antes de limpar os dados do site.
- Câmera e microfone exigem endereço seguro (https) ou o arquivo aberto no próprio computador.
- Vídeo 1080p ocupa cerca de 30 a 45 MB por minuto; no celular, baixe aula por aula se ficar pesado.
- Para o vídeo sair na horizontal, deite o celular em um apoio.
