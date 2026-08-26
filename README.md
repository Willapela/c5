# Guia de Proxy Reverso para o C5 Panel

Este guia mostra como publicar o **C5 Panel** com um domínio, sem expor diretamente a porta `2000` na internet. O exemplo considera que o painel está rodando na VPS em `127.0.0.1:2000` e que o domínio utilizado será `painel.seudominio.com`.

> **Importante:** substitua `painel.seudominio.com` pelo seu domínio real em todos os comandos e arquivos de configuração.

## 1. Como funciona

O fluxo recomendado é:

```
Usuário → HTTPS/Cloudflare → Nginx na VPS → C5 Panel em 127.0.0.1:2000
```

O Node.js continua escutando na porta `2000`, mas o usuário acessa somente o domínio pela porta HTTPS padrão. O Nginx recebe as requisições, encaminha os cabeçalhos necessários e mantém o suporte a conexões persistentes e WebSocket.

| Componente | Função | Exemplo |
| --- | --- | --- |
| C5 Panel | Aplicação Node.js | `127.0.0.1:2000` |
| Nginx | Proxy reverso | Portas `80` e `443` |
| Domínio | Endereço público | `painel.seudominio.com` |
| PM2 | Gerenciamento do processo | `c5-panel` |
| Cloudflare | DNS, proxy e proteção opcional | Registro tipo `A` |

## 2. Pré-requisitos

Antes de configurar o proxy reverso, confirme que o painel está funcionando diretamente na VPS:

```bash
curl -I http://127.0.0.1:2000/login
pm2 status
```

O primeiro comando deve retornar uma resposta HTTP do painel. O processo do PM2 deve aparecer como `online`.

Também é necessário que o domínio possua um registro DNS apontando para o IP público da VPS. Se estiver usando Cloudflare, crie um registro como este:

| Tipo | Nome | Valor | Proxy |
| --- | --- | --- | --- |
| `A` | `painel` | IP público da VPS | Laranja ou cinza |

Durante os testes iniciais, o proxy da Cloudflare pode ficar desativado, com a nuvem cinza. Depois que o HTTPS funcionar diretamente na VPS, ele pode ser ativado.

## 3. Instalar o Nginx

Em distribuições baseadas em Debian ou Ubuntu, execute:

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

Se o firewall UFW estiver ativo, libere apenas SSH, HTTP e HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw status
```

A porta `2000` não precisa ser liberada no firewall quando o Node.js escuta somente em `127.0.0.1`. Essa é a configuração preferível, pois o painel fica acessível externamente apenas através do Nginx.

## 4. Criar a configuração do proxy reverso

Crie um arquivo para o domínio:

```bash
sudo nano /etc/nginx/sites-available/c5-panel
```

Cole o conteúdo abaixo, trocando o domínio:

```
server {
    listen 80;
    listen [::]:80;

    server_name painel.seudominio.com;

    location / {
        proxy_pass http://127.0.0.1:2000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Necessário para WebSocket e conexões persistentes.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

Ative o site e valide a configuração:

```bash
sudo ln -s /etc/nginx/sites-available/c5-panel /etc/nginx/sites-enabled/c5-panel
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Se `nginx -t` informar que a sintaxe está correta, abra `http://painel.seudominio.com` no navegador. Se o domínio não carregar, confirme o DNS, o IP da VPS e os logs abaixo:

```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

## 5. Ativar HTTPS com Certbot

Para gerar um certificado gratuito usando Let's Encrypt, instale o Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d painel.seudominio.com
```

Quando solicitado, escolha a opção para redirecionar HTTP para HTTPS. Ao final, valide a renovação automática:

```bash
sudo certbot renew --dry-run
```

Depois do certificado, a configuração do Nginx normalmente será atualizada automaticamente. O bloco HTTPS deverá continuar encaminhando para o mesmo upstream:

```
location / {
    proxy_pass http://127.0.0.1:2000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

Após qualquer alteração manual:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Usar Cloudflare na frente do Nginx

Se o DNS estiver na Cloudflare, ative o proxy laranja somente depois de o domínio funcionar diretamente com HTTPS. Em **SSL/TLS**, use o modo **Full (strict )** quando a VPS possuir um certificado válido do Let's Encrypt.

O caminho recomendado é:

```
Navegador HTTPS → Cloudflare HTTPS → Nginx HTTPS → Node.js HTTP local
```

Não configure o C5 Panel para escutar diretamente em uma porta pública diferente apenas por causa da Cloudflare. O Nginx deve continuar sendo o ponto de entrada na VPS, e o Node.js deve continuar no endereço local:

```
127.0.0.1:2000
```

Se a Cloudflare apresentar erro `502` ou `504`, teste cada trecho separadamente:

```bash
curl -I http://127.0.0.1:2000/login
curl -I http://127.0.0.1/login -H 'Host: painel.seudominio.com'
curl -I https://painel.seudominio.com/login
```

O primeiro teste verifica o Node.js, o segundo verifica o Nginx localmente e o terceiro verifica DNS, HTTPS e Cloudflare.

## 7. Ajustar o endereço público do painel

O endereço público configurado no `.env` deve usar HTTPS e o mesmo domínio publicado no proxy:

```
APP_BASE_URL=https://painel.seudominio.com
```

Depois de alterar o `.env`, reinicie o processo com as variáveis atualizadas:

```bash
cd ~/c5
pm2 restart c5-panel --update-env
pm2 save
```

O `APP_BASE_URL` é especialmente importante para links públicos, recuperação de senha por e-mail e endereços de atualização usados pelo aplicativo.

## 8. Garantir que o PM2 permaneça ativo

Se o painel ainda não estiver cadastrado no PM2, execute na pasta do projeto:

```bash
cd ~/c5
pm2 start index.js --name c5-panel
pm2 save
pm2 startup
```

O último comando exibirá outro comando específico para o sistema. Copie e execute esse comando com `sudo`, quando solicitado. Depois, confirme:

```bash
pm2 status
pm2 logs c5-panel --lines 50
```

Para atualizações futuras do painel:

```bash
cd ~/c5
git pull origin main
npm install
pm2 restart c5-panel --update-env
pm2 save
```

## 9. Erros comuns

| Sintoma | Causa provável | Verificação |
| --- | --- | --- |
| `502 Bad Gateway` | Node.js parado ou upstream incorreto | `pm2 status` e `curl http://127.0.0.1:2000/login` |
| `504 Gateway Timeout` | Aplicação travada ou timeout insuficiente | `pm2 logs c5-panel` e logs do Nginx |
| Domínio não abre | DNS ainda não propagado ou apontando para IP errado | `dig +short painel.seudominio.com` |
| Certbot falha | Portas 80/443 bloqueadas ou DNS incorreto | `sudo ufw status` e teste sem proxy Cloudflare |
| Loop de redirecionamento | Modo SSL incompatível na Cloudflare | Usar `Full (strict )` com certificado válido |
| Tela ou links incorretos | `APP_BASE_URL` ainda aponta para IP ou HTTP | Revisar `.env` e reiniciar com `--update-env` |
| WebSocket não conecta | Cabeçalhos `Upgrade` ausentes | Revisar `proxy_http_version` e os dois `proxy_set_header` |

## 10. Checklist final

Antes de entregar o domínio para os usuários, confirme que o painel responde em HTTPS, o certificado está válido, o processo do PM2 está online, a porta `2000` não está exposta publicamente e o `.env` usa o domínio correto.

```bash
curl -I https://painel.seudominio.com/login
pm2 status
sudo nginx -t
sudo ss -lntp | grep -E ':80|:443|:2000'
```

O resultado esperado é o Nginx escutando nas portas `80` e `443`, enquanto o Node.js escuta localmente em `127.0.0.1:2000`.

## Referências

[1]: https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/ "NGINX — Setting up a reverse proxy"

[2]: https://certbot.eff.org/instructions "Certbot — Instructions"

[3]: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/ "Cloudflare — SSL/TLS encryption modes"

[4]: https://pm2.keymetrics.io/docs/usage/startup/ "PM2 — Startup hook"
