# SitedoPai — demonstração no Codespaces

Ambiente de **teste**, com dados **fictícios** e **modo demonstração** (matriz,
modelo e tipo de PT sem validação profissional). Não use em atividade real.

## Abrir o site
1. Espere a mensagem **"Pronto"** no terminal (a primeira vez leva alguns minutos).
2. O site abre sozinho. Se não abrir: aba **PORTS** (embaixo) → linha **3000** → ícone do globo.
3. Escolha um usuário fictício na tela de entrada.

## Se algo travar
No terminal, rode:
```
bash .devcontainer/start.sh
```
Registros de erro ficam em `.logs/api.log` e `.logs/web.log`.

## Recomeçar os dados do zero
Apague o Codespace (github.com/codespaces → ⋯ → Delete) e crie outro pelo
mesmo link: ele já vem com os dados de demonstração limpos.

## Desligar
O Codespace desliga sozinho após um tempo sem uso. Os dados ficam guardados
até você apagar o Codespace (github.com/codespaces).
