@echo off
rem Abre o Estudio de Narracao no Chrome (ou no Edge). Duplo clique neste arquivo.
setlocal
set "URL=file:///%~dp0index.html"
set "URL=%URL:\=/%"
set "URL=%URL: =%20%"
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if exist %%P (
    start "" %%P --new-window "%URL%"
    exit /b 0
  )
)
echo Nao encontrei o Chrome nem o Edge. Abra o arquivo index.html com um deles.
pause
