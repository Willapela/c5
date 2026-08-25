const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 2000);
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_c5g_key_for_testing';

// Planos de acesso (valores em BRL). Ajuste via env se quiser.
const PLANS = [
    {
        id: 'monthly',
        name: 'Mensal',
        days: 30,
        price: Number(process.env.PLAN_MONTHLY_PRICE || 29.9),
        description: 'Acesso completo por 30 dias'
    },
    {
        id: 'quarterly',
        name: 'Trimestral',
        days: 90,
        price: Number(process.env.PLAN_QUARTERLY_PRICE || 79.9),
        description: 'Acesso completo por 90 dias'
    },
    {
        id: 'yearly',
        name: 'Anual',
        days: 365,
        price: Number(process.env.PLAN_YEARLY_PRICE || 249.9),
        description: 'Acesso completo por 1 ano'
    }
];

const PIX_KEY = process.env.PIX_KEY || '';
const PIX_NAME = process.env.PIX_NAME || 'ConnectPlus';
const PIX_CITY = process.env.PIX_CITY || 'SAO PAULO';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Mercado Pago â€” mesmo fluxo do PainelPro (PIX automÃ¡tico)
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || '';

const ORDERS_DIR = path.join(__dirname, 'data', 'orders');
if (!fs.existsSync(ORDERS_DIR)) {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
}

function getPlan(planId) {
    return PLANS.find((p) => p.id === String(planId || '')) || null;
}

async function mpCreatePixPayment({ amount, description, email, externalReference }) {
    if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN nÃ£o configurado');
    const body = {
        transaction_amount: Number(Number(amount).toFixed(2)),
        description: String(description || 'Plano ConnectPlus').slice(0, 250),
        payment_method_id: 'pix',
        payer: {
            email: String(email || 'cliente@connectplus.local')
        },
        external_reference: String(externalReference || ''),
        notification_url: process.env.MP_NOTIFICATION_URL || undefined
    };
    const res = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': `${externalReference || Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = data.message || data.error || JSON.stringify(data) || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    const tx = data.point_of_interaction && data.point_of_interaction.transaction_data
        ? data.point_of_interaction.transaction_data
        : {};
    return {
        paymentId: String(data.id),
        status: data.status,
        qrCode: tx.qr_code || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        ticketUrl: tx.ticket_url || ''
    };
}

async function mpGetPayment(paymentId) {
    if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN nÃ£o configurado');
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

function fulfillOrder(order) {
    if (!order || order.status === 'paid') return order;
    const target = getUser(order.username);
    if (!target) throw new Error('UsuÃ¡rio do pedido nÃ£o encontrado');
    extendUserAccess(target, order.days);
    target.plan = order.planId;
    saveUser(target.username, target);
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.expiresAtAfter = target.expiresAt;
    saveOrder(order);
    return order;
}

function saveOrder(order) {
    const file = path.join(ORDERS_DIR, `${order.id}.json`);
    fs.writeFileSync(file, JSON.stringify(order, null, 2));
    return order;
}

function getOrder(id) {
    const file = path.join(ORDERS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function listPendingOrders() {
    if (!fs.existsSync(ORDERS_DIR)) return [];
    return fs.readdirSync(ORDERS_DIR)
        .filter((n) => n.endsWith('.json'))
        .map((n) => {
            try { return JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, n), 'utf8')); }
            catch (e) { return null; }
        })
        .filter((o) => o && o.status === 'pending');
}

function formatBRL(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}


app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Pasta pÃƒÂºblica para APKs por usuÃƒÂ¡rio
const APK_DIR = path.join(__dirname, 'public', 'apks');
if (!fs.existsSync(APK_DIR)) {
    fs.mkdirSync(APK_DIR, { recursive: true });
}

const apkStorage = multer.diskStorage({
    destination(req, file, cb) {
        const username = req.user && req.user.username ? String(req.user.username) : 'anon';
        const dir = path.join(APK_DIR, username);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(req, file, cb) {
        cb(null, 'app.apk');
    }
});

const apkUpload = multer({
    storage: apkStorage,
    limits: { fileSize: 120 * 1024 * 1024 }, // 120 MB
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        const ok = name.endsWith('.apk') || file.mimetype === 'application/vnd.android.package-archive'
            || file.mimetype === 'application/octet-stream';
        if (!ok) return cb(new Error('Envie apenas arquivo .apk'));
        cb(null, true);
    }
});

// Recursos de atualizaÃƒÂ§ÃƒÂ£o do aplicativo. Os arquivos ficam em public/updates
// para que possam ser substituÃƒÂ­dos sem misturar dados privados dos usuÃƒÂ¡rios.
const UPDATE_RESOURCES = {
    appupdate: 'appupdate',
    config: 'config',
    sms: 'sms',
    theme: 'theme'
};

function requestBaseUrl(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function parseUserConfig(user) {
    try {
        const config = JSON.parse(user.config_json || '{}');
        // MantÃƒÂ©m apenas o contrato ConnectPlus e metadados internos necessÃƒÂ¡rios ao painel.
        const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'Theme', 'Servers', 'Sms'];
        Object.keys(config).forEach((key) => {
            if (!allowedRootKeys.includes(key)) delete config[key];
        });
        if (!Array.isArray(config.Servers)) config.Servers = [];
        if (config.UdpPort === undefined) config.UdpPort = '7300';
        if (config.Contato === undefined) config.Contato = '';
        if (config.Site === undefined) config.Site = '';
        if (config.Actualization === undefined) config.Actualization = 'false';
        // Normaliza para string "true" | "false" (contrato do app)
        config.Actualization = (config.Actualization === true || config.Actualization === 'true' || config.Actualization === 1 || config.Actualization === '1')
            ? 'true'
            : 'false';
        // Bloco SMS do aplicativo
        const sms = (config.Sms && typeof config.Sms === 'object') ? config.Sms : {};
        config.Sms = {
            Version: String(sms.Version ?? '1'),
            Update: String(sms.Update ?? ''),
            Notes: String(sms.Notes ?? '')
        };
        return config;
    } catch (error) {
        return {
            Version: 1,
            UdpPort: '7300',
            Contato: '',
            Site: '',
            Servers: [],
            Sms: { Version: '1', Update: '', Notes: '' }
        };
    }
}

function buildSmsPayload(user) {
    const stored = parseUserConfig(user);
    const sms = stored.Sms || {};
    return {
        Version: String(sms.Version ?? '1'),
        Update: String(sms.Update ?? ''),
        Notes: String(sms.Notes ?? '')
    };
}

function buildUserConfig(req, username, user) {
    const stored = parseUserConfig(user);
    const base = requestBaseUrl(req);
    const configUrl = `${base}/${encodeURIComponent(username)}/config`;
    const serverKeys = ['Name', 'ColorName', 'Description', 'ColorDescription', 'FLAG', 'ServerIP', 'ServerPort', 'CheckUser', 'USER', 'PASS', 'Payload', 'ProxyIP', 'ProxyPort', 'SNI', 'Path', 'Color', 'Info'];
    const servers = Array.isArray(stored.Servers) ? stored.Servers.map((server) => {
        const clean = {};
        serverKeys.forEach((key) => {
            if (server[key] !== undefined) clean[key] = server[key];
        });
        if (!['Ssl', 'Direct', 'Proxy', 'Tlsws', 'XHTTP'].includes(clean.Info)) clean.Info = 'Tlsws';
        return clean;
    }) : [];

    // O endpoint pÃƒÂºblico segue exclusivamente o modelo ConnectPlus enviado.
    return {
        Version: String(stored.Version ?? 1),
        Update: configUrl,
        UdpPort: String(stored.UdpPort ?? '7300'),
        Contato: String(stored.Contato ?? ''),
        Site: String(stored.Site ?? ''),
        Servers: servers
    };
}

function buildAppUpdate(req, username, user) {
    const stored = parseUserConfig(user);
    const actualization = (stored.Actualization === true || stored.Actualization === 'true' || stored.Actualization === 1 || stored.Actualization === '1')
        ? 'true'
        : 'false';
    return {
        Version: String(stored.AppVersion ?? stored.Version ?? 1),
        VersionName: String(stored.VersionName ?? stored.Version ?? '1'),
        Update: `${requestBaseUrl(req)}/${encodeURIComponent(username)}/config`,
        Actualization: actualization,
        UpdateApk: stored.UpdateApk || ''
    };
}

for (const [resource, filename] of Object.entries(UPDATE_RESOURCES)) {
    app.get(`/${resource}`, (req, res) => {
        const file = path.join(__dirname, 'public', 'updates', filename);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recurso nÃƒÂ£o encontrado' });
        res.type('application/json').sendFile(file);
    });
}

app.get('/updates/manifest.json', (req, res) => {
    const manifest = path.join(__dirname, 'public', 'updates', 'manifest.json');
    if (!fs.existsSync(manifest)) return res.status(404).json({ error: 'Manifesto nÃƒÂ£o encontrado' });
    res.type('application/json').sendFile(manifest);
});

// Improved Database setup for many users (File per user)
const DB_DIR = path.join(__dirname, 'data', 'users');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

function getUser(username) {
    if (!username) return null;
    const file = path.join(DB_DIR, `${username}.json`);
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return null;
}

function saveUser(username, data) {
    const file = path.join(DB_DIR, `${username}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function listUsers() {
    if (!fs.existsSync(DB_DIR)) return [];
    return fs.readdirSync(DB_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(DB_DIR, name), 'utf8'));
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean);
}

function findUserByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    return listUsers().find((u) => String(u.email || '').trim().toLowerCase() === target) || null;
}

function findUserByLogin(login) {
    const value = String(login || '').trim();
    if (!value) return null;
    // Login aceita usuÃƒÂ¡rio ou e-mail
    if (value.includes('@')) return findUserByEmail(value);
    return getUser(value);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isAdminUser(user) {
    return !!(user && (user.isAdmin === true || user.role === 'admin'));
}

function getExpiresAt(user) {
    if (!user || !user.expiresAt) return null;
    const d = new Date(user.expiresAt);
    return Number.isNaN(d.getTime()) ? null : d;
}

function isSubscriptionActive(user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    // Contas antigas sem expiresAt continuam ativas atÃ© definir validade
    const exp = getExpiresAt(user);
    if (!exp) return true;
    return exp.getTime() > Date.now();
}

function addDaysIso(days) {
    const d = new Date();
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString();
}

function extendUserAccess(user, days) {
    const now = Date.now();
    const current = getExpiresAt(user);
    const base = current && current.getTime() > now ? new Date(current.getTime()) : new Date();
    base.setDate(base.getDate() + Number(days || 0));
    user.expiresAt = base.toISOString();
    return user.expiresAt;
}

function getCdnPool(user) {
    return Array.isArray(user.cdn_pool) ? user.cdn_pool.filter(Boolean).map(String) : [];
}

function parseCdnInput(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(/[\n,#]+/);
    return [...new Set(
        list
            .flatMap(item => String(item || '').split(/[\n,#]+/))
            .map(item => item.trim())
            .filter(Boolean)
            .map(normalizeCdnUrl)
            .filter(Boolean)
    )].slice(0, 100);
}

function normalizeCdnUrl(value) {
    try {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) return null;
        return url.toString().replace(/\/$/, '');
    } catch (error) {
        return null;
    }
}

async function testCdnUrl(value) {
    const started = Date.now();
    let target;
    try {
        target = normalizeCdnUrl(value);
        if (!target) throw new Error('URL invÃƒÂ¡lida');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(target, {
            method: 'GET',
            headers: { Range: 'bytes=0-0', 'User-Agent': 'C5G-CDN-Pool/1.0' },
            redirect: 'follow',
            signal: controller.signal
        });
        clearTimeout(timer);
        // Para Azion: ONLINE apenas com HTTP 400 (host no ar). 404/outros = OFFLINE
        const online = response.status === 400;
        return {
            url: target,
            online,
            status: response.status,
            latency: Date.now() - started,
            host: new URL(response.url).hostname
        };
    } catch (error) {
        return {
            url: target || String(value || ''),
            online: false,
            status: 0,
            latency: Date.now() - started,
            error: error.name === 'AbortError' ? 'Tempo esgotado' : error.message
        };
    }
}

// Migration from old database.json
const OLD_DB_FILE = path.join(__dirname, 'database.json');
if (fs.existsSync(OLD_DB_FILE)) {
    try {
        const oldDb = JSON.parse(fs.readFileSync(OLD_DB_FILE, 'utf8'));
        if (oldDb.users) {
            oldDb.users.forEach(u => {
                saveUser(u.username, u);
            });
        }
        fs.renameSync(OLD_DB_FILE, path.join(__dirname, 'database.json.bak'));
        console.log('Migrated old database to file-per-user system.');
    } catch(e) {
        console.error('Failed to migrate db', e);
    }
}

// Default Config from the app
const DEFAULT_CONFIG = {
    "Version": 1,
    "VersionName": "1.0.0",
    "AppVersion": 1,
    "UpdateApk": "",
    "Actualization": "false",
    "UdpPort": "7300",
    "Contato": "",
    "Site": "",
    "Sms": {
        "Version": "1",
        "Update": "",
        "Notes": ""
    },
    "Theme": {
        "Version": "1",
        "Update": "",
        "AppName": "ConnectPlus",
        "ImgFundo": "https://cdn.awsli.com.br/2500x2500/549/549871/produto/29108392/60cdfb3799.jpg",
        "ImgLogo": "https://i.imgur.com/KMpSZOq.gif",
        "ImgBanner": "",
        "ImgMenu": "https://telegra.ph/file/828fa0ae4f65228764d39.png",
        "ImgLogs": "https://telegra.ph/file/ca921a93220cc2281f147.png",
        "ImgCheck": "https://telegra.ph/file/12ab1b8c54f671f72bc73.png",
        "ImgUser": "https://telegra.ph/file/51cfbf308fa6a293d6f7b.png",
        "ImgPass": "https://telegra.ph/file/0aae4b5cc75034f04611d.png",
        "ColorOne": "#7A333333",
        "ColorTwo": "#7A333333",
        "ColorStarter": "#7A333333",
        "ColorDialogs": "#84ffffff",
        "ColorButtons": "#333333",
        "ImgUpdate": "https://i.imgur.com/CJFEvDW.png"
    },
    "Servers": []
};

// Middleware to check authentication
function requireAuth(req, res, next) {
    const token = req.cookies.auth_token;
    if (!token) return res.redirect('/login');

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.redirect('/login');
        const user = getUser(decoded.username);
        if (!user) {
            res.clearCookie('auth_token');
            return res.redirect('/login');
        }
        req.user = { id: user.id, username: user.username };
        req.userFull = user;
        next();
    });
}

function requireActivePlan(req, res, next) {
    const user = req.userFull || getUser(req.user && req.user.username);
    if (!user) return res.redirect('/login');
    if (isSubscriptionActive(user)) return next();
    return res.redirect('/renew');
}

function requireActivePlanApi(req, res, next) {
    const user = req.userFull || getUser(req.user && req.user.username);
    if (!user) return res.status(401).json({ error: 'NÃ£o autenticado' });
    if (isSubscriptionActive(user)) return next();
    return res.status(402).json({ error: 'Plano expirado', expiresAt: user.expiresAt || null });
}

// Routes
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// Auth Routes
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = findUserByLogin(username);

    if (!user) return res.render('login', { error: 'UsuÃƒÂ¡rio/e-mail ou senha invÃƒÂ¡lidos' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'UsuÃƒÂ¡rio/e-mail ou senha invÃƒÂ¡lidos' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('auth_token', token).redirect('/dashboard');
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
        return res.render('register', { error: 'Preencha usuÃƒÂ¡rio, e-mail e senha' });
    }

    if (!/^[a-zA-Z0-9]+$/.test(username)) {
        return res.render('register', { error: 'UsuÃƒÂ¡rio deve ser alfanumÃƒÂ©rico (sem espaÃƒÂ§os)' });
    }

    if (!isValidEmail(email)) {
        return res.render('register', { error: 'E-mail invÃƒÂ¡lido' });
    }

    if (password.length < 6) {
        return res.render('register', { error: 'Senha deve ter no mÃƒÂ­nimo 6 caracteres' });
    }

    try {
        if (getUser(username)) {
            return res.render('register', { error: 'Nome de usuÃƒÂ¡rio jÃƒÂ¡ existe' });
        }
        if (findUserByEmail(email)) {
            return res.render('register', { error: 'E-mail jÃƒÂ¡ cadastrado' });
        }

        const hash = await bcrypt.hash(password, 10);
        const configJsonStr = JSON.stringify(DEFAULT_CONFIG, null, 2);

        saveUser(username, {
            id: Date.now(),
            username,
            email,
            password: hash,
            config_json: configJsonStr,
            created_at: new Date().toISOString(),
            plan: 'trial',
            expiresAt: addDaysIso(7),
            isAdmin: false
        });
        res.redirect('/login');
    } catch (e) {
        res.render('register', { error: 'Erro no servidor' });
    }
});

// Perfil do usuÃƒÂ¡rio logado
app.get('/api/profile', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    res.json({
        username: user.username,
        email: user.email || '',
        created_at: user.created_at || null,
        plan: user.plan || 'trial',
        expiresAt: user.expiresAt || null,
        active: isSubscriptionActive(user),
        isAdmin: isAdminUser(user)
    });
});

app.post('/api/profile', requireAuth, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });

    const email = String(req.body.email || '').trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (email) {
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'E-mail invÃƒÂ¡lido' });
        }
        const other = findUserByEmail(email);
        if (other && other.username !== user.username) {
            return res.status(400).json({ error: 'E-mail jÃƒÂ¡ estÃƒÂ¡ em uso por outra conta' });
        }
        user.email = email;
    }

    if (newPassword) {
        if (!currentPassword) {
            return res.status(400).json({ error: 'Informe a senha atual para trocar a senha' });
        }
        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Senha atual incorreta' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Nova senha deve ter no mÃƒÂ­nimo 6 caracteres' });
        }
        user.password = await bcrypt.hash(newPassword, 10);
    }

    saveUser(user.username, user);
    res.json({
        ok: true,
        username: user.username,
        email: user.email || ''
    });
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_token').redirect('/login');
});

// RenovaÃ§Ã£o / plano expirado
app.get('/renew', requireAuth, (req, res) => {
    const user = req.userFull || getUser(req.user.username);
    if (!user) return res.redirect('/login');
    if (isSubscriptionActive(user)) return res.redirect('/dashboard');
    const exp = getExpiresAt(user);
    const expLabel = exp ? exp.toLocaleString('pt-BR') : 'sem data';
    res.status(402).send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acesso expirado</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;background:#070b14;color:#f8fafc}
.card{max-width:440px;width:92%;padding:2rem;border-radius:1.2rem;border:1px solid rgba(110,168,254,.2);background:linear-gradient(145deg,#111c2e,#09111f);box-shadow:0 24px 70px rgba(0,0,0,.4)}
h1{margin:0 0 .75rem;font-size:1.5rem}
p{color:#94a3b8;line-height:1.5}
a{color:#6ea8fe}
.badge{display:inline-block;margin:.5rem 0 1rem;padding:.35rem .7rem;border-radius:999px;background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.28);color:#fb7185;font-size:.8rem;font-weight:700}
</style></head>
<body><div class="card">
<h1>Acesso expirado</h1>
<div class="badge">Plano inativo</div>
<p>Sua conta <strong>${user.username}</strong> nÃ£o estÃ¡ ativa.</p>
<p>Validade: <strong>${expLabel}</strong></p>
<p>Escolha um plano e pague via PIX para liberar o acesso automaticamente apÃ³s a confirmaÃ§Ã£o.</p>
<p style="margin-top:1.5rem"><a href="/planos" style="display:inline-block;padding:.7rem 1.1rem;border-radius:.7rem;background:linear-gradient(135deg,#5f9dfb,#356ff1);color:#fff;text-decoration:none;font-weight:700">Ver planos</a></p>
<p style="margin-top:1rem"><a href="/logout">Sair</a></p>
</div></body></html>`);
});


// ===== Planos e pagamento (PIX) =====
app.get('/planos', requireAuth, (req, res) => {
    const user = req.userFull || getUser(req.user.username);
    if (!user) return res.redirect('/login');
    res.render('planos', {
        user: {
            username: user.username,
            email: user.email || '',
            plan: user.plan || 'trial',
            expiresAt: user.expiresAt || null,
            active: isSubscriptionActive(user),
            isAdmin: isAdminUser(user)
        },
        plans: PLANS,
        pixKey: PIX_KEY,
        pixName: PIX_NAME,
        formatBRL
    });
});

app.post('/api/plans/order', requireAuth, async (req, res) => {
    try {
        const user = req.userFull || getUser(req.user.username);
        if (!user) return res.status(401).json({ error: 'NÃ£o autenticado' });
        const plan = getPlan(req.body.planId);
        if (!plan) return res.status(400).json({ error: 'Plano invÃ¡lido' });

        const order = {
            id: `ord_${Date.now()}_${user.username}`,
            username: user.username,
            planId: plan.id,
            planName: plan.name,
            days: plan.days,
            price: plan.price,
            status: 'pending',
            method: MP_ACCESS_TOKEN ? 'mercadopago_pix' : 'pix_manual',
            paymentId: null,
            createdAt: new Date().toISOString(),
            paidAt: null
        };

        // Mercado Pago PIX (PainelPro-style) â€” gera QR / copia-e-cola
        if (MP_ACCESS_TOKEN) {
            const email = user.email || `${user.username}@connectplus.local`;
            const mp = await mpCreatePixPayment({
                amount: plan.price,
                description: `ConnectPlus ${plan.name} (${plan.days} dias)`,
                email,
                externalReference: order.id
            });
            order.paymentId = mp.paymentId;
            order.mpStatus = mp.status;
            saveOrder(order);
            return res.json({
                ok: true,
                order,
                pix: {
                    provider: 'mercadopago',
                    paymentId: mp.paymentId,
                    key: mp.qrCode, // copia e cola PIX
                    qrCode: mp.qrCode,
                    qrCodeBase64: mp.qrCodeBase64,
                    ticketUrl: mp.ticketUrl,
                    amount: plan.price,
                    amountLabel: formatBRL(plan.price),
                    message: 'Escaneie o QR Code ou copie o cÃ³digo PIX. O acesso libera automÃ¡tico apÃ³s o pagamento.'
                }
            });
        }

        // Fallback: chave PIX manual (admin confirma)
        saveOrder(order);
        res.json({
            ok: true,
            order,
            pix: {
                provider: 'manual',
                key: PIX_KEY || null,
                name: PIX_NAME,
                city: PIX_CITY,
                amount: plan.price,
                amountLabel: formatBRL(plan.price),
                message: PIX_KEY
                    ? `FaÃ§a o PIX de ${formatBRL(plan.price)} e aguarde a confirmaÃ§Ã£o do admin.`
                    : 'Configure MP_ACCESS_TOKEN (Mercado Pago) ou PIX_KEY no servidor.'
            }
        });
    } catch (err) {
        console.error('order error', err);
        res.status(500).json({ error: err.message || 'Falha ao criar pagamento' });
    }
});

// Admin confirma pagamento e libera dias


// Consulta status do pagamento (polling no front â€” igual PainelPro verify)
app.get('/api/plans/order/:id/status', requireAuth, async (req, res) => {
    try {
        const order = getOrder(req.params.id);
        if (!order) return res.status(404).json({ error: 'Pedido nÃ£o encontrado' });
        const user = req.userFull || getUser(req.user.username);
        if (!user) return res.status(401).json({ error: 'NÃ£o autenticado' });
        if (order.username !== user.username && !isAdminUser(user)) {
            return res.status(403).json({ error: 'Sem permissÃ£o' });
        }

        if (order.status === 'paid') {
            return res.json({ ok: true, status: 'paid', order });
        }

        // Mercado Pago: consulta API
        if (order.paymentId && MP_ACCESS_TOKEN) {
            const pay = await mpGetPayment(order.paymentId);
            order.mpStatus = pay.status;
            if (pay.status === 'approved') {
                fulfillOrder(order);
                return res.json({ ok: true, status: 'paid', order });
            }
            saveOrder(order);
            return res.json({ ok: true, status: pay.status || 'pending', order });
        }

        res.json({ ok: true, status: order.status || 'pending', order });
    } catch (err) {
        console.error('status error', err);
        res.status(500).json({ error: err.message || 'Erro ao consultar pagamento' });
    }
});

// Webhook Mercado Pago (opcional)
app.post('/api/webhooks/mercadopago', async (req, res) => {
    try {
        res.status(200).send('OK');
        const paymentId = req.body && (req.body.data && req.body.data.id) || req.query.id || req.body.id;
        if (!paymentId || !MP_ACCESS_TOKEN) return;
        const pay = await mpGetPayment(paymentId);
        if (pay.status !== 'approved') return;
        const ref = pay.external_reference;
        if (!ref) return;
        const order = getOrder(ref);
        if (!order || order.status === 'paid') return;
        order.paymentId = String(paymentId);
        fulfillOrder(order);
        console.log('MP webhook: order paid', ref);
    } catch (err) {
        console.error('webhook mp', err);
    }
});

app.post('/api/admin/confirm-order', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin) && !(ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN)) {
        return res.status(403).json({ error: 'Apenas admin' });
    }
    const order = getOrder(req.body.orderId);
    if (!order) return res.status(404).json({ error: 'Pedido nÃ£o encontrado' });
    if (order.status === 'paid') return res.json({ ok: true, order, message: 'JÃ¡ estava pago' });
    try {
        fulfillOrder(order);
        order.confirmedBy = admin.username;
        saveOrder(order);
        res.json({ ok: true, order, expiresAt: order.expiresAtAfter });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Falha ao confirmar' });
    }
});

// Admin libera dias manualmente
app.post('/api/admin/extend', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin) && !(ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN)) {
        return res.status(403).json({ error: 'Apenas admin' });
    }
    const username = String(req.body.username || '').trim();
    const days = Number(req.body.days || 0);
    if (!username || !days || days < 1) return res.status(400).json({ error: 'username e days obrigatÃ³rios' });
    const target = getUser(username);
    if (!target) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    extendUserAccess(target, days);
    if (req.body.plan) target.plan = String(req.body.plan);
    saveUser(target.username, target);
    res.json({ ok: true, username: target.username, expiresAt: target.expiresAt, plan: target.plan });
});

app.get('/api/admin/orders/pending', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin)) return res.status(403).json({ error: 'Apenas admin' });
    res.json({ orders: listPendingOrders() });
});


// Dashboard
app.get('/dashboard', requireAuth, requireActivePlan, (req, res) => {
    const user = req.userFull || getUser(req.user.username);
    if (!user) return res.redirect('/login');

    // Preserve the external port (for example :2000) in all generated URLs.
    const hostUrl = requestBaseUrl(req);
    const apkRelative = `/apks/${encodeURIComponent(user.username)}/app.apk`;
    const apkPath = path.join(APK_DIR, user.username, 'app.apk');
    const hasApk = fs.existsSync(apkPath);
    res.render('dashboard', {
        user: {
            ...req.user,
            email: user.email || '',
            created_at: user.created_at || null,
            plan: user.plan || 'trial',
            expiresAt: user.expiresAt || null,
            active: isSubscriptionActive(user),
            isAdmin: isAdminUser(user)
        },
        configStr: JSON.stringify(parseUserConfig(user), null, 2),
        appUrl: `${hostUrl}/${encodeURIComponent(user.username)}/config`,
        appUpdateUrl: `${hostUrl}/${encodeURIComponent(user.username)}/appupdate`,
        smsUrl: `${hostUrl}/${encodeURIComponent(user.username)}/sms`,
        themeUrl: `${hostUrl}/${encodeURIComponent(user.username)}/theme`,
        apkUrl: hasApk ? `${hostUrl}${apkRelative}` : '',
        hasApk
    });
});

// Upload do APK do aplicativo (atualizaÃƒÂ§ÃƒÂ£o)
app.post('/api/apk/upload', requireAuth, requireActivePlanApi, (req, res) => {
    apkUpload.single('apk')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Falha no upload do APK' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const user = getUser(req.user.username);
        if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });

        const hostUrl = requestBaseUrl(req);
        const apkUrl = `${hostUrl}/apks/${encodeURIComponent(user.username)}/app.apk`;

        const config = parseUserConfig(user);
        config.UpdateApk = apkUrl;
        if (req.body && req.body.AppVersion) {
            config.AppVersion = Number(req.body.AppVersion) || config.AppVersion || 1;
        }
        if (req.body && req.body.VersionName) {
            config.VersionName = String(req.body.VersionName);
        }
        user.config_json = JSON.stringify(config, null, 2);
        saveUser(user.username, user);

        res.json({
            ok: true,
            apkUrl,
            AppVersion: config.AppVersion,
            VersionName: config.VersionName,
            UpdateApk: config.UpdateApk
        });
    });
});

app.delete('/api/apk', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const apkPath = path.join(APK_DIR, user.username, 'app.apk');
    if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);

    const config = parseUserConfig(user);
    const hostUrl = requestBaseUrl(req);
    const selfUrl = `${hostUrl}/apks/${encodeURIComponent(user.username)}/app.apk`;
    if (config.UpdateApk === selfUrl) config.UpdateApk = '';
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true });
});

app.get('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    res.json({
        urls: getCdnPool(user),
        results: Array.isArray(user.cdn_pool_results) ? user.cdn_pool_results : [],
        active: Array.isArray(user.cdn_pool_active) ? user.cdn_pool_active : [],
        testedAt: user.cdn_pool_tested_at || null
    });
});

app.post('/api/cdn-pool', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const urls = parseCdnInput(req.body.urls);
    user.cdn_pool = urls;
    saveUser(user.username, user);
    res.json({ urls });
});

app.post('/api/cdn-pool/test', requireAuth, requireActivePlanApi, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const urls = parseCdnInput(
        Array.isArray(req.body.urls) && req.body.urls.length
            ? req.body.urls
            : getCdnPool(user)
    );
    const results = await Promise.all(urls.map(testCdnUrl));
    const active = results.filter(item => item.online).map(item => item.url);
    // Guarda o ÃƒÂºltimo teste para nÃƒÂ£o sumir ao recarregar/relogar
    user.cdn_pool_results = results;
    user.cdn_pool_active = active;
    user.cdn_pool_tested_at = new Date().toISOString();
    saveUser(user.username, user);
    res.json({ results, active, testedAt: user.cdn_pool_tested_at });
});

app.delete('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const target = normalizeCdnUrl(req.body.url);
    user.cdn_pool = getCdnPool(user).filter(url => url !== target);
    saveUser(user.username, user);
    res.json({ urls: user.cdn_pool });
});

function normalizeConfigPayload(nextConfig) {
    const parsedVersion = Number(nextConfig.Version);
    const parsedAppVersion = Number(nextConfig.AppVersion);
    nextConfig.Version = Number.isFinite(parsedVersion) ? parsedVersion : 1;
    nextConfig.AppVersion = Number.isFinite(parsedAppVersion) ? parsedAppVersion : nextConfig.Version;
    nextConfig.VersionName = String(
        nextConfig.VersionName !== undefined && nextConfig.VersionName !== null && nextConfig.VersionName !== ''
            ? nextConfig.VersionName
            : nextConfig.Version
    );
    nextConfig.UpdateApk = String(nextConfig.UpdateApk ?? '');
    nextConfig.Actualization = (nextConfig.Actualization === true || nextConfig.Actualization === 'true' || nextConfig.Actualization === 1 || nextConfig.Actualization === '1')
        ? 'true'
        : 'false';

    const smsIn = (nextConfig.Sms && typeof nextConfig.Sms === 'object') ? nextConfig.Sms : {};
    nextConfig.Sms = {
        Version: String(smsIn.Version ?? '1'),
        Update: String(smsIn.Update ?? ''),
        Notes: String(smsIn.Notes ?? '')
    };

    const themeIn = (nextConfig.Theme && typeof nextConfig.Theme === 'object') ? nextConfig.Theme : {};
    nextConfig.Theme = {
        ...themeIn,
        Version: String(themeIn.Version ?? '1'),
        AppName: 'ConnectPlus'
    };

    const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'Theme', 'Servers', 'Sms'];
    Object.keys(nextConfig).forEach((key) => {
        if (!allowedRootKeys.includes(key)) delete nextConfig[key];
    });
    nextConfig.UdpPort = String(nextConfig.UdpPort ?? '7300');
    nextConfig.Contato = String(nextConfig.Contato ?? '');
    nextConfig.Site = String(nextConfig.Site ?? '');
    if (!Array.isArray(nextConfig.Servers)) nextConfig.Servers = [];
    return nextConfig;
}

// Save completo Ã¢â‚¬â€ versÃƒÂµes 100% manuais (sem auto +1)
app.post('/dashboard/save', requireAuth, requireActivePlanApi, (req, res) => {
    const { config_json } = req.body;
    try {
        const nextConfig = normalizeConfigPayload(JSON.parse(config_json));
        const user = getUser(req.user.username);
        if (!user) return res.status(500).send('Erro ao salvar as configuraÃƒÂ§ÃƒÂµes');
        user.config_json = JSON.stringify(nextConfig, null, 2);
        saveUser(user.username, user);
        return res.json({
            ok: true,
            Version: nextConfig.Version,
            AppVersion: nextConfig.AppVersion,
            VersionName: nextConfig.VersionName,
            Actualization: nextConfig.Actualization,
            UpdateApk: nextConfig.UpdateApk,
            Sms: nextConfig.Sms,
            Theme: nextConfig.Theme
        });
    } catch (e) {
        res.status(400).send('Formato JSON invÃƒÂ¡lido');
    }
});

// Salva sÃƒÂ³ SMS (nÃƒÂ£o mexe em Version da config nem no tema)
app.post('/api/sms', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const config = parseUserConfig(user);
    const body = req.body || {};
    config.Sms = {
        Version: String(body.Version ?? config.Sms?.Version ?? '1'),
        Update: String(body.Update ?? ''),
        Notes: String(body.Notes ?? '')
    };
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true, Sms: config.Sms });
});

// Salva sÃƒÂ³ Theme (nÃƒÂ£o mexe em Version da config nem no SMS)
app.post('/api/theme', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const config = parseUserConfig(user);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    config.Theme = {
        ...((config.Theme && typeof config.Theme === 'object') ? config.Theme : {}),
        ...body,
        Version: String(body.Version ?? config.Theme?.Version ?? '1'),
        AppName: 'ConnectPlus'
    };
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true, Theme: config.Theme });
});

// Exportar configuraÃƒÂ§ÃƒÂ£o completa
app.get('/api/config/export', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    const config = parseUserConfig(user);
    res.setHeader('Content-Disposition', `attachment; filename="c5g-config-${user.username}.json"`);
    res.type('application/json').send(JSON.stringify(config, null, 2));
});

// Importar configuraÃƒÂ§ÃƒÂ£o completa
app.post('/api/config/import', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃƒÂ¡rio nÃƒÂ£o encontrado' });
    try {
        let incoming = req.body;
        if (incoming && incoming.config_json) {
            incoming = typeof incoming.config_json === 'string'
                ? JSON.parse(incoming.config_json)
                : incoming.config_json;
        }
        if (typeof incoming === 'string') incoming = JSON.parse(incoming);
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ error: 'JSON invÃƒÂ¡lido' });
        }
        const nextConfig = normalizeConfigPayload(incoming);
        user.config_json = JSON.stringify(nextConfig, null, 2);
        saveUser(user.username, user);
        res.json({ ok: true, config: nextConfig });
    } catch (e) {
        res.status(400).json({ error: 'JSON invÃƒÂ¡lido' });
    }
});

// Endpoints pÃƒÂºblicos no formato esperado pelo aplicativo.
app.get('/:username/config', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    res.type('application/json').send(buildUserConfig(req, username, user));
});

app.get('/:username/appupdate', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    res.type('application/json').send(buildAppUpdate(req, username, user));
});

app.get('/:username/sms', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    res.type('application/json').send(buildSmsPayload(user));
});

app.get('/:username/theme', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    const config = parseUserConfig(user);
    const savedTheme = (config.Theme && typeof config.Theme === 'object') ? config.Theme : {};
    const theme = {
        Version: String(savedTheme.Version ?? config.Version ?? 1),
        Update: `${requestBaseUrl(req)}/${encodeURIComponent(username)}/theme`,
        AppName: 'ConnectPlus',
        ImgFundo: savedTheme.ImgFundo || '',
        ImgLogo: savedTheme.ImgLogo || '',
        ImgBanner: savedTheme.ImgBanner || '',
        ImgMenu: savedTheme.ImgMenu || '',
        ImgLogs: savedTheme.ImgLogs || '',
        ImgCheck: savedTheme.ImgCheck || '',
        ImgUser: savedTheme.ImgUser || '',
        ImgPass: savedTheme.ImgPass || '',
        ColorOne: savedTheme.ColorOne || '',
        ColorTwo: savedTheme.ColorTwo || '',
        ColorStarter: savedTheme.ColorStarter || '',
        ColorDialogs: savedTheme.ColorDialogs || '',
        ColorButtons: savedTheme.ColorButtons || '',
        ImgUpdate: savedTheme.ImgUpdate || ''
    };
    res.type('application/json').send(theme);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`C5G Panel listening on port ${PORT}`);
});
