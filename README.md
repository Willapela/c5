# C5G Panel

Painel web Node.js para gerenciamento de configurações de aplicativos, servidores e recursos de atualização. Esta versão inclui os recursos `appupdate`, `config`, `sms` e `theme`.

## Instalação rápida na VPS

O servidor precisa ter Ubuntu ou Debian, acesso SSH e Node.js 18 ou superior.

```bash
git clone https://github.com/Willapela/c5g-panel-install.git
cd c5g-panel-install
bash install.sh
```

Depois, abra `http://IP_DA_VPS:2000/register`, crie a primeira conta e faça login. Para produção, use HTTPS por meio de Nginx ou outro proxy reverso.

## Instalação manual

```bash
npm ci --omit=dev
export JWT_SECRET="troque-por-uma-chave-longa-e-aleatoria"
node index.js
```

Para manter o processo ativo, recomenda-se usar PM2:

```bash
npm install --global pm2
pm2 start index.js --name c5-panel
pm2 save
```

## Links dos recursos

Com o domínio configurado, os recursos ficam disponíveis nestas rotas:

| Recurso | URL relativa |
| --- | --- |
| Atualização do aplicativo | `/appupdate` |
| Configuração | `/config` |
| SMS | `/sms` |
| Tema | `/theme` |
| Manifesto | `/updates/manifest.json` |

Os arquivos estão em `public/updates/`. O arquivo `config` publicado é uma versão sanitizada, sem usuário, senha ou IP real. Substitua-o pela sua configuração privada somente na VPS e nunca faça commit de credenciais no GitHub.

## UUID de atualização unificado

Cada usuário possui um `updateUuid` persistente. O UUID é gerado automaticamente no cadastro e também é criado sob demanda para contas antigas. Ele aparece na visão geral e em **Meu Perfil**.

O aplicativo pode consultar apenas o endpoint abaixo para receber os links de configuração, appupdate, SMS e tema:

```
GET /u/<UUID>
```

As rotas derivadas `/u/<UUID>/config`, `/u/<UUID>/appupdate`, `/u/<UUID>/sms` e `/u/<UUID>/theme` entregam os payloads individuais. As rotas antigas por usuário continuam ativas para compatibilidade.

## Atualização automática e salvamento geral

O dashboard possui um único botão **Salvar alterações** na barra lateral. Ele salva de uma vez as configurações gerais, servidores, tema e SMS. O **pool CDN mantém seu próprio botão Salvar pool CDN**, porque seus links são administrados separadamente. Os botões individuais de configuração, tema e SMS foram removidos para evitar que uma parte do conteúdo fique salva e outra não.

As versões de configuração, tema e SMS sobem automaticamente somente quando o conteúdo correspondente é alterado. A versão do APK continua manual: `AppVersion`, `VersionName`, `Actualization` e `UpdateApk` só mudam quando o usuário envia ou ajusta os dados do aplicativo.

## Recuperação de senha por e-mail

O login possui o link **Esqueci minha senha**. O usuário informa o e-mail e recebe um link temporário. O token é armazenado somente como hash, expira por padrão em 30 minutos, pode ser utilizado uma única vez e é invalidado quando a senha é alterada.

Configure o envio SMTP na VPS com variáveis de ambiente. Nunca faça commit da senha SMTP no GitHub:

```bash
# URL pública usada pelo dashboard, UUIDs e recuperação de senha
export APP_BASE_URL="https://connect.dspeed.shop"
export SMTP_HOST="smtp.seu-provedor.com"
export SMTP_PORT="587"
export SMTP_SECURE="false"
export SMTP_USER="seu-email@seu-dominio.com"
export SMTP_PASS="sua-senha-ou-app-password"
export SMTP_FROM="ConnectPlus <seu-email@seu-dominio.com>"
export RESET_TOKEN_TTL_MINUTES="30"
```

Para SMTP em porta 465, use `SMTP_SECURE=true`. Em provedores que exigem autenticação de aplicativo, utilize a senha de aplicativo fornecida pelo provedor, não a senha principal da conta.

## Segurança

O banco de usuários fica em `data/users/` e é ignorado pelo Git. Defina sempre `JWT_SECRET` antes de colocar o painel na internet. Não use credenciais de servidores diretamente em um repositório público. Em produção, use HTTPS para impedir que credenciais e links de recuperação sejam transmitidos sem proteção.

## Estrutura principal

```
index.js                 Backend Express
views/                   Telas EJS
public/css/              Estilos
public/updates/          Arquivos appupdate, config, sms e theme
data/users/              Dados locais dos usuários, não publicados
install.sh               Instalação automatizada
```
