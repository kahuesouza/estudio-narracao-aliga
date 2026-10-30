# Estúdio de Narração · A Liga

Aplicativo para narrar as 3 aulas da CVDentus para a A Liga Dental Education **no ritmo do próprio narrador**. O texto aparece em teleprompter e acompanha a voz; o aplicativo grava imagem (câmera frontal ou traseira) e som, trecho por trecho, e exporta um pacote em ZIP. Funciona no computador e no celular.

**Abrir:** https://kahuesouza.github.io/estudio-narracao-aliga/

Use o **Google Chrome** (ou Edge) no computador, ou o **Chrome / Safari** no celular, e permita câmera e microfone quando o navegador pedir.

## Passo a passo

1. Toque em **Ligar câmera e microfone**. Escolha **Frontal**, **Traseira** ou **Sem imagem**. Fale: o medidor tem que mexer.
2. Abra uma aula e escolha o trecho. Toque em **Gravar este trecho**; depois de 3 segundos de contagem, leia no seu ritmo. O texto acompanha a voz.
3. A gravação encerra sozinha depois da última frase (ou toque em **Terminar**). Confira o take e, se quiser, grave de novo.
4. No painel, **Baixar tudo (ZIP)** ou **Baixar esta aula**. No celular há também **Compartilhar / enviar**.

## O que vai no ZIP

- `NN_trecho.mp4` — gravação original com imagem e som (H.264 + AAC no Chrome e Safari; WebM no Firefox).
- `NN_trecho_audio.mp3` — áudio mono, 48 kHz, 192 kbps, volume nivelado em −16 LUFS, silêncio do começo e do fim aparado.
- `manifesto.json` — texto, duração e ponto onde a fala começa e termina (`corte_inicio_s`, `corte_fim_s`) em cada trecho. É a base para alinhar as animações ao tempo de fala do narrador.

## Como o texto acompanha a voz

1. **Reconhecimento de fala** (Web Speech API do Chrome, pt-BR): compara o que foi ouvido com o roteiro, palavra por palavra, tolerando erros de reconhecimento, e reencontra o ponto se o narrador pular ou reler uma frase.
2. **Ritmo**: o aplicativo estima as palavras por minuto do narrador e empurra o destaque entre uma confirmação e outra. Sem reconhecimento (ou se ele falhar), o texto segue só o ritmo médio, ajustável.
3. Toque em qualquer palavra para ressincronizar; as setas ← → pulam uma frase.

## Observações

- As gravações ficam salvas só no navegador do aparelho. Baixe o ZIP antes de limpar os dados do navegador.
- O reconhecimento de fala do Chrome envia o áudio ao serviço de voz do Google. A gravação em si não é enviada a lugar nenhum; só vai o que o narrador baixar e enviar.
- A câmera e o microfone exigem endereço seguro (https) ou o arquivo aberto no próprio computador. O link acima já é seguro.
- Em vídeo de 1080p a gravação ocupa cerca de 30 a 45 MB por minuto. Se o ZIP completo ficar pesado no celular, baixe aula por aula.
- Teclas: **Espaço** grava/para, **+** e **−** mudam a letra, **F** modo foco, **↑ ↓** ajustam o ritmo médio.
- Para usar no computador sem internet, baixe o repositório (Code → Download ZIP), descompacte e abra `ABRIR_ESTUDIO.bat` (sem internet o texto segue o ritmo médio).
