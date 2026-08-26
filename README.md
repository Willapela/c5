# C5G Panel

Painel web Node.js para gerenciamento de configuraÃ§Ãµes de aplicativos, servidores e recursos de atualizaÃ§Ã£o. Esta versÃ£o inclui os recursos `appupdate`, `config`, `sms` e `theme`.

## InstalaÃ§Ã£o rÃ¡pida na VPS

O servidor precisa ter Ubuntu ou Debian, acesso SSH e Node.js 18 ou superior.

```bash
git clone https://github.com/Willapela/c5g-panel-install.git
cd c5g-panel-install
bash install.sh
```

Depois, abra `http://IP_DA_VPS:2000/register`, crie a primeira conta e faÃ§a login. Para produÃ§Ã£o, use HTTPS por meio de Nginx ou outro proxy reverso.

## InstalaÃ§Ã£o manual

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

Com o domÃ­nio configurado, os recursos ficam disponÃ­veis nestas rotas:

| Recurso | URL relativa |
|---|---|
| AtualizaÃ§Ã£o do aplicativo | `/appupdate` |
| ConfiguraÃ§Ã£o | `/config` |
| SMS | `/sms` |
| Tema | `/theme` |
| Manifesto | `/updates/manifest.json` |

Os arquivos estÃ£o em `public/updates/`. O arquivo `config` publicado Ã© uma versÃ£o sanitizada, sem usuÃ¡rio, senha ou IP real. Substitua-o pela sua configuraÃ§Ã£o privada somente na VPS e nunca faÃ§a commit de credenciais no GitHub.

## UUID de atualizaÃ§Ã£o unificado

Cada usuÃ¡rio possui um `updateUuid` persistente. O UUID Ã© gerado automaticamente no cadastro e tambÃ©m Ã© criado sob demanda para contas antigas. Ele aparece na visÃ£o geral e em **Meu Perfil**.

O aplicativo pode consultar apenas o endpoint abaixo para receber os links de configuraÃ§Ã£o, appupdate, SMS e tema:

```text
GET /u/<UUID>
```

As rotas derivadas `/u/<UUID>/config`, `/u/<UUID>/appupdate`, `/u/<UUID>/sms` e `/u/<UUID>/theme` entregam os payloads individuais. As rotas antigas por usuÃ¡rio continuam ativas para compatibilidade.

## AtualizaÃ§Ã£o automÃ¡tica e salvamento geral

O dashboard possui um Ãºnico botÃ£o **Salvar alteraÃ§Ãµes** na barra lateral. Ele salva de uma vez as configuraÃ§Ãµes gerais, servidores, tema e SMS. O **pool CDN mantÃ©m seu prÃ³prio botÃ£o Salvar pool CDN**, porque seus links sÃ£o administrados separadamente. Os botÃµes individuais de configuraÃ§Ã£o, tema e SMS foram removidos para evitar que uma parte do conteÃºdo fique salva e outra nÃ£o.

As versÃµes de configuraÃ§Ã£o, tema e SMS sobem automaticamente somente quando o conteÃºdo correspondente Ã© alterado. A versÃ£o do APK continua manual: `AppVersion`, `VersionName`, `Actualization` e `UpdateApk` sÃ³ mudam quando o usuÃ¡rio envia ou ajusta os dados do aplicativo.

## RecuperaÃ§Ã£o de senha por e-mail

O login possui o link **Esqueci minha senha**. O usuÃ¡rio informa o e-mail e recebe um link temporÃ¡rio. O token Ã© armazenado somente como hash, expira por padrÃ£o em 30 minutos, pode ser utilizado uma Ãºnica vez e Ã© invalidado quando a senha Ã© alterada.

Configure o envio SMTP na VPS com variÃ¡veis de ambiente. Nunca faÃ§a commit da senha SMTP no GitHub:

```bash
export APP_BASE_URL="https://painel.seu-dominio.com"
export SMTP_HOST="smtp.seu-provedor.com"
export SMTP_PORT="587"
export SMTP_SECURE="false"
export SMTP_USER="seu-email@seu-dominio.com"
export SMTP_PASS="sua-senha-ou-app-password"
export SMTP_FROM="ConnectPlus <seu-email@seu-dominio.com>"
export RESET_TOKEN_TTL_MINUTES="30"
```

Para SMTP em porta 465, use `SMTP_SECURE=true`. Em provedores que exigem autenticaÃ§Ã£o de aplicativo, utilize a senha de aplicativo fornecida pelo provedor, nÃ£o a senha principal da conta.

## SeguranÃ§a

O banco de usuÃ¡rios fica em `data/users/` e Ã© ignorado pelo Git. Defina sempre `JWT_SECRET` antes de colocar o painel na internet. NÃ£o use credenciais de servidores diretamente em um repositÃ³rio pÃºblico. Em produÃ§Ã£o, use HTTPS para impedir que credenciais e links de recuperaÃ§Ã£o sejam transmitidos sem proteÃ§Ã£o.

## Estrutura principal

```text
index.js                 Backend Express
views/                   Telas EJS
public/css/              Estilos
public/updates/          Arquivos appupdate, config, sms e theme
data/users/              Dados locais dos usuÃ¡rios, nÃ£o publicados
install.sh               InstalaÃ§Ã£o automatizada
```
