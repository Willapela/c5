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
pm2 start index.js --name c5g-panel
pm2 save
```

## Links dos recursos

Com o domínio configurado, os recursos ficam disponíveis nestas rotas:

| Recurso | URL relativa |
|---|---|
| Atualização do aplicativo | `/appupdate` |
| Configuração | `/config` |
| SMS | `/sms` |
| Tema | `/theme` |
| Manifesto | `/updates/manifest.json` |

Os arquivos estão em `public/updates/`. O arquivo `config` publicado é uma versão sanitizada, sem usuário, senha ou IP real. Substitua-o pela sua configuração privada somente na VPS e nunca faça commit de credenciais no GitHub.

## Segurança

O banco de usuários fica em `data/users/` e é ignorado pelo Git. Defina sempre `JWT_SECRET` antes de colocar o painel na internet. Não use credenciais de servidores diretamente em um repositório público.

## Estrutura principal

```text
index.js                 Backend Express
views/                   Telas EJS
public/css/              Estilos
public/updates/          Arquivos appupdate, config, sms e theme
data/users/              Dados locais dos usuários, não publicados
install.sh               Instalação automatizada
```
