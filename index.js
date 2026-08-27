const express = require('express');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');

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

// Recuperação de senha por e-mail. As credenciais devem ficar somente nas variáveis de ambiente.
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER).trim();
const SMTP_CONNECTION_TIMEOUT_MS = Math.max(3000, Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000));
const SMTP_GREETING_TIMEOUT_MS = Math.max(3000, Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000));
const SMTP_SOCKET_TIMEOUT_MS = Math.max(5000, Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000));
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = Math.max(5, Number(process.env.RESET_TOKEN_TTL_MINUTES || 30)) * 60 * 1000;
const RESET_RATE_WINDOW_MS = 15 * 60 * 1000;
const RESET_RATE_MAX = 5;
const resetRateBuckets = new Map();

// Mercado Pago — token pode vir do painel admin (data/settings.json) ou do env
const ORDERS_DIR = path.join(__dirname, 'data', 'orders');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
if (!fs.existsSync(ORDERS_DIR)) {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
}
if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
}

function readSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
        }
    } catch (e) { /* ignore */ }
    return {};
}

function writeSettings(next) {
    const cur = readSettings();
    const merged = { ...cur, ...next, updatedAt: new Date().toISOString() };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    return merged;
}

function getMpAccessToken() {
    const s = readSettings();
    return String(s.mpAccessToken || process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
}

function getPixKey() {
    const s = readSettings();
    return String(s.pixKey || process.env.PIX_KEY || PIX_KEY || '').trim();
}

function getPlanPrice(planId, fallback) {
    const s = readSettings();
    const prices = s.planPrices || {};
    if (prices[planId] !== undefined && prices[planId] !== null && prices[planId] !== '') {
        return Number(prices[planId]);
    }
    return Number(fallback);
}

function getPlansLive() {
    return PLANS.map((p) => ({
        ...p,
        price: getPlanPrice(p.id, p.price)
    }));
}

function getPlan(planId) {
    const base = PLANS.find((p) => p.id === String(planId || '')) || null;
    if (!base) return null;
    return { ...base, price: getPlanPrice(base.id, base.price) };
}

async function mpCreatePixPayment({ amount, description, email, externalReference }) {
    if (!getMpAccessToken()) throw new Error('MP_ACCESS_TOKEN não configurado');
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
            'Authorization': `Bearer ${getMpAccessToken()}`,
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
    if (!getMpAccessToken()) throw new Error('MP_ACCESS_TOKEN não configurado');
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { 'Authorization': `Bearer ${getMpAccessToken()}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

function fulfillOrder(order) {
    if (!order || order.status === 'paid') return order;
    const target = getUser(order.username);
    if (!target) throw new Error('Usuário do pedido não encontrado');
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
// Serve o Vue localmente para que o dashboard não dependa do unpkg atrás de proxy/Worker.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'vue', 'dist')));

// Pasta pÃºblica para APKs por usuÃ¡rio
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

// Recursos de atualizaÃ§Ã£o do aplicativo. Os arquivos ficam em public/updates
// para que possam ser substituÃ­dos sem misturar dados privados dos usuÃ¡rios.
const UPDATE_RESOURCES = {
    appupdate: 'appupdate',
    config: 'config',
    sms: 'sms',
    theme: 'theme'
};

function requestBaseUrl(req) {
    if (APP_BASE_URL) return APP_BASE_URL;
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host');
    return `${protocol}://${host}`;
}

function parseUserConfig(user) {
    try {
        const config = JSON.parse(user.config_json || '{}');
        // MantÃ©m apenas o contrato ConnectPlus e metadados internos necessÃ¡rios ao painel.
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

function buildPublicResourceUrl(req, identifier, resource, publicPrefix = '') {
    const prefix = String(publicPrefix || '');
    return `${requestBaseUrl(req)}${prefix}/${encodeURIComponent(identifier)}/${resource}`;
}

function buildUpdateEntryUrl(req, uuid) {
    return `${requestBaseUrl(req)}/u/${encodeURIComponent(uuid)}`;
}

function buildUserConfig(req, username, user, publicPrefix = '') {
    const stored = parseUserConfig(user);
    const configUrl = buildPublicResourceUrl(req, username, 'config', publicPrefix);
    const serverKeys = ['Name', 'ColorName', 'Description', 'ColorDescription', 'FLAG', 'ServerIP', 'ServerPort', 'CheckUser', 'USER', 'PASS', 'Payload', 'ProxyIP', 'ProxyPort', 'SNI', 'Path', 'Color', 'Info'];
    const servers = Array.isArray(stored.Servers) ? stored.Servers.map((server) => {
        const clean = {};
        serverKeys.forEach((key) => {
            if (server[key] !== undefined) clean[key] = server[key];
        });
        if (!['Ssl', 'Direct', 'Proxy', 'Tlsws', 'XHTTP'].includes(clean.Info)) clean.Info = 'Tlsws';
        return clean;
    }) : [];

    // O endpoint pÃºblico segue exclusivamente o modelo ConnectPlus enviado.
    return {
        Version: String(stored.Version ?? 1),
        Update: configUrl,
        UdpPort: String(stored.UdpPort ?? '7300'),
        Contato: String(stored.Contato ?? ''),
        Site: String(stored.Site ?? ''),
        Servers: servers
    };
}

function buildAppUpdate(req, username, user, publicPrefix = '') {
    const stored = parseUserConfig(user);
    const actualization = (stored.Actualization === true || stored.Actualization === 'true' || stored.Actualization === 1 || stored.Actualization === '1')
        ? 'true'
        : 'false';
    return {
        Version: String(stored.AppVersion ?? stored.Version ?? 1),
        VersionName: String(stored.VersionName ?? stored.Version ?? '1'),
        Update: buildPublicResourceUrl(req, username, 'config', publicPrefix),
        Actualization: actualization,
        UpdateApk: stored.UpdateApk || ''
    };
}

for (const [resource, filename] of Object.entries(UPDATE_RESOURCES)) {
    app.get(`/${resource}`, (req, res) => {
        const file = path.join(__dirname, 'public', 'updates', filename);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recurso nÃ£o encontrado' });
        res.type('application/json').sendFile(file);
    });
}

app.get('/updates/manifest.json', (req, res) => {
    const manifest = path.join(__dirname, 'public', 'updates', 'manifest.json');
    if (!fs.existsSync(manifest)) return res.status(404).json({ error: 'Manifesto nÃ£o encontrado' });
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

const UPDATE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUpdateUuid(value) {
    return UPDATE_UUID_PATTERN.test(String(value || '').trim());
}

function ensureUserUpdateUuid(user) {
    if (!user) return null;
    if (isValidUpdateUuid(user.updateUuid)) return String(user.updateUuid).toLowerCase();
    user.updateUuid = crypto.randomUUID();
    saveUser(user.username, user);
    return user.updateUuid;
}

function findUserByUpdateUuid(value) {
    const target = String(value || '').trim().toLowerCase();
    if (!isValidUpdateUuid(target)) return null;
    return listUsers().find((user) => String(user.updateUuid || '').toLowerCase() === target) || null;
}

function buildThemePayload(req, username, user, publicPrefix = '') {
    const config = parseUserConfig(user);
    const savedTheme = (config.Theme && typeof config.Theme === 'object') ? config.Theme : {};
    return {
        Version: String(savedTheme.Version ?? config.Version ?? 1),
        Update: buildPublicResourceUrl(req, username, 'theme', publicPrefix),
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
}

function buildUpdateManifest(req, uuid, user) {
    const config = parseUserConfig(user);
    const resources = {
        config: buildPublicResourceUrl(req, uuid, 'config', '/u'),
        appupdate: buildPublicResourceUrl(req, uuid, 'appupdate', '/u'),
        sms: buildPublicResourceUrl(req, uuid, 'sms', '/u'),
        theme: buildPublicResourceUrl(req, uuid, 'theme', '/u')
    };
    return {
        uuid,
        version: String(config.Version ?? 1),
        Update: resources.config,
        AppUpdate: resources.appupdate,
        SmsUpdate: resources.sms,
        ThemeUpdate: resources.theme,
        config: resources.config,
        appupdate: resources.appupdate,
        sms: resources.sms,
        theme: resources.theme,
        resources
    };
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

function hasSmtpConfiguration() {
    return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

function getMailer() {
    if (!hasSmtpConfiguration()) return null;
    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
}

function getAppBaseUrl(req) {
    return APP_BASE_URL || requestBaseUrl(req);
}

function getPasswordResetUrl(req, token) {
    return `${getAppBaseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
}

function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issuePasswordResetToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetTokenHash = hashResetToken(token);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    user.passwordResetRequestedAt = new Date().toISOString();
    return token;
}

function findUserByResetToken(token) {
    const value = String(token || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) return null;
    const tokenHash = hashResetToken(value);
    const now = Date.now();
    return listUsers().find((user) => {
        if (!user.passwordResetTokenHash || user.passwordResetTokenHash !== tokenHash) return false;
        const expires = new Date(user.passwordResetExpiresAt || 0).getTime();
        return Number.isFinite(expires) && expires > now;
    }) || null;
}

function clearPasswordResetToken(user) {
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    delete user.passwordResetRequestedAt;
}

function isPasswordResetRateLimited(req, email) {
    const now = Date.now();
    for (const [key, bucket] of resetRateBuckets.entries()) {
        if (!bucket || now - bucket.startedAt >= RESET_RATE_WINDOW_MS) resetRateBuckets.delete(key);
    }
    const key = `${req.ip || 'unknown'}|${String(email || '').toLowerCase()}`;
    const bucket = resetRateBuckets.get(key);
    if (!bucket) {
        resetRateBuckets.set(key, { startedAt: now, count: 1 });
        return false;
    }
    if (bucket.count >= RESET_RATE_MAX) return true;
    bucket.count += 1;
    return false;
}

async function verifySmtpConfiguration() {
    if (!hasSmtpConfiguration()) {
        console.warn('SMTP de recuperação: NÃO configurado (defina SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS)');
        return;
    }
    try {
        await getMailer().verify();
        console.log(`SMTP de recuperação: OK (${SMTP_HOST}:${SMTP_PORT})`);
    } catch (error) {
        console.error('SMTP de recuperação: FALHA na verificação:', error.message || error);
    }
}

async function sendPasswordResetEmail(user, resetUrl) {
    const mailer = getMailer();
    if (!mailer) throw new Error('SMTP não configurado');
    await mailer.sendMail({
        from: SMTP_FROM,
        to: user.email,
        subject: 'Redefinição de senha — ConnectPlus',
        text: `Olá ${user.username},\n\nRecebemos uma solicitação para redefinir a senha da sua conta ConnectPlus.\n\nAcesse o link abaixo em até ${Math.round(RESET_TOKEN_TTL_MS / 60000)} minutos:\n${resetUrl}\n\nSe você não solicitou essa alteração, ignore esta mensagem.`,
        html: `<p>Olá <strong>${user.username}</strong>,</p><p>Recebemos uma solicitação para redefinir a senha da sua conta ConnectPlus.</p><p>O link abaixo expira em ${Math.round(RESET_TOKEN_TTL_MS / 60000)} minutos e pode ser usado uma única vez:</p><p><a href="${resetUrl}">Redefinir minha senha</a></p><p>Se você não solicitou essa alteração, ignore esta mensagem.</p>`
    });
}

function findUserByLogin(login) {
    const value = String(login || '').trim();
    if (!value) return null;
    // Login aceita usuÃ¡rio ou e-mail
    if (value.includes('@')) return findUserByEmail(value);
    return getUser(value);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isAdminUser(user) {
    if (!user) return false;
    if (user.isAdmin === true || user.isAdmin === 1 || user.isAdmin === 'true' || user.isAdmin === '1') return true;
    if (String(user.role || '').toLowerCase() === 'admin') return true;
    // username Admin (legado)
    if (String(user.username || '').toLowerCase() === 'admin') return true;
    return false;
}

function getExpiresAt(user) {
    if (!user || !user.expiresAt) return null;
    const d = new Date(user.expiresAt);
    return Number.isNaN(d.getTime()) ? null : d;
}

function isSubscriptionActive(user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    // Contas antigas sem expiresAt continuam ativas até definir validade
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
        if (!target) throw new Error('URL invÃ¡lida');
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
    const wantsJson = String(req.originalUrl || '').startsWith('/api/')
        || (req.headers.accept || '').includes('application/json')
        || req.xhr;

    if (!token) {
        if (wantsJson) return res.status(401).json({ error: 'Não autenticado' });
        return res.redirect('/login');
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            if (wantsJson) return res.status(401).json({ error: 'Sessão inválida' });
            return res.redirect('/login');
        }
        const user = getUser(decoded.username);
        if (!user) {
            res.clearCookie('auth_token');
            if (wantsJson) return res.status(401).json({ error: 'Usuário não encontrado' });
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
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    if (isSubscriptionActive(user)) return next();
    return res.status(402).json({ error: 'Plano expirado', expiresAt: user.expiresAt || null });
}

// Routes
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// Auth Routes
app.get('/login', (req, res) => {
    const message = req.query.reset === '1' ? 'Senha redefinida com sucesso. Faça login com a nova senha.' : null;
    res.render('login', { error: null, message });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = findUserByLogin(username);

    if (!user) return res.render('login', { error: 'UsuÃ¡rio/e-mail ou senha invÃ¡lidos', message: null });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'UsuÃ¡rio/e-mail ou senha invÃ¡lidos', message: null });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('auth_token', token).redirect('/dashboard');
});

app.get('/forgot-password', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.render('forgot-password', { error: null, message: null, email: '' });
});

app.post('/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const genericMessage = 'Se existir uma conta com esse e-mail, enviaremos um link para redefinir a senha.';

    if (!isValidEmail(email)) {
        return res.render('forgot-password', {
            error: 'Informe um e-mail válido.',
            message: null,
            email
        });
    }

    if (isPasswordResetRateLimited(req, email)) {
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    }

    const user = findUserByEmail(email);
    if (!user) {
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    }

    if (!hasSmtpConfiguration()) {
        console.error('Password reset requested but SMTP is not configured. Define SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.');
        return res.render('forgot-password', {
            error: 'O serviço de e-mail está temporariamente indisponível. Tente novamente mais tarde.',
            message: null,
            email
        });
    }

    try {
        const resetToken = issuePasswordResetToken(user);
        saveUser(user.username, user);
        await sendPasswordResetEmail(user, getPasswordResetUrl(req, resetToken));
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    } catch (error) {
        clearPasswordResetToken(user);
        saveUser(user.username, user);
        console.error('Password reset email error:', error.stack || error.message || error);
        return res.render('forgot-password', {
            error: 'Não foi possível enviar o e-mail agora. Tente novamente mais tarde.',
            message: null,
            email
        });
    }
});

app.get('/reset-password', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const token = String(req.query.token || '').trim();
    const user = findUserByResetToken(token);
    res.render('reset-password', {
        error: user ? null : 'Este link é inválido ou já expirou.',
        message: null,
        token: user ? token : ''
    });
});

app.post('/reset-password', async (req, res) => {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const user = findUserByResetToken(token);

    if (!user) {
        return res.render('reset-password', {
            error: 'Este link é inválido ou já expirou.',
            message: null,
            token: ''
        });
    }
    if (password.length < 6) {
        return res.render('reset-password', {
            error: 'A nova senha deve ter no mínimo 6 caracteres.',
            message: null,
            token
        });
    }
    if (password !== confirmPassword) {
        return res.render('reset-password', {
            error: 'As senhas não conferem.',
            message: null,
            token
        });
    }

    user.password = await bcrypt.hash(password, 10);
    clearPasswordResetToken(user);
    saveUser(user.username, user);
    return res.redirect('/login?reset=1');
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
        return res.render('register', { error: 'Preencha usuÃ¡rio, e-mail e senha' });
    }

    if (!/^[a-zA-Z0-9]+$/.test(username)) {
        return res.render('register', { error: 'UsuÃ¡rio deve ser alfanumÃ©rico (sem espaÃ§os)' });
    }

    if (!isValidEmail(email)) {
        return res.render('register', { error: 'E-mail invÃ¡lido' });
    }

    if (password.length < 6) {
        return res.render('register', { error: 'Senha deve ter no mÃ­nimo 6 caracteres' });
    }

    try {
        if (getUser(username)) {
            return res.render('register', { error: 'Nome de usuÃ¡rio jÃ¡ existe' });
        }
        if (findUserByEmail(email)) {
            return res.render('register', { error: 'E-mail jÃ¡ cadastrado' });
        }

        const hash = await bcrypt.hash(password, 10);
        const configJsonStr = JSON.stringify(DEFAULT_CONFIG, null, 2);

        saveUser(username, {
            id: Date.now(),
            username,
            email,
            password: hash,
            config_json: configJsonStr,
            updateUuid: crypto.randomUUID(),
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

// Perfil do usuÃ¡rio logado
app.get('/api/profile', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const updateUuid = ensureUserUpdateUuid(user);
    res.json({
        username: user.username,
        email: user.email || '',
        updateUuid,
        updateUrl: buildUpdateEntryUrl(req, updateUuid),
        created_at: user.created_at || null,
        plan: user.plan || 'trial',
        expiresAt: user.expiresAt || null,
        active: isSubscriptionActive(user),
        isAdmin: isAdminUser(user)
    });
});

app.post('/api/profile', requireAuth, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });

    const email = String(req.body.email || '').trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (email) {
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'E-mail invÃ¡lido' });
        }
        const other = findUserByEmail(email);
        if (other && other.username !== user.username) {
            return res.status(400).json({ error: 'E-mail jÃ¡ estÃ¡ em uso por outra conta' });
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
            return res.status(400).json({ error: 'Nova senha deve ter no mÃ­nimo 6 caracteres' });
        }
        user.password = await bcrypt.hash(newPassword, 10);
        clearPasswordResetToken(user);
    }

    saveUser(user.username, user);
    const updateUuid = ensureUserUpdateUuid(user);
    res.json({
        ok: true,
        username: user.username,
        email: user.email || '',
        updateUuid,
        updateUrl: buildUpdateEntryUrl(req, updateUuid)
    });
});

app.post('/api/profile/update-uuid/regenerate', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    user.updateUuid = crypto.randomUUID();
    saveUser(user.username, user);
    res.json({
        ok: true,
        updateUuid: user.updateUuid,
        updateUrl: buildUpdateEntryUrl(req, user.updateUuid)
    });
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_token').redirect('/login');
});

// Renovação / plano expirado
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
<p>Sua conta <strong>${user.username}</strong> não está ativa.</p>
<p>Validade: <strong>${expLabel}</strong></p>
<p>Escolha um plano e pague via PIX para liberar o acesso automaticamente após a confirmação.</p>
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
        plans: getPlansLive(),
        pixKey: getPixKey(),
        pixName: PIX_NAME,
        formatBRL
    });
});

app.post('/api/plans/order', requireAuth, async (req, res) => {
    try {
        const user = req.userFull || getUser(req.user.username);
        if (!user) return res.status(401).json({ error: 'Não autenticado' });
        const plan = getPlan(req.body.planId);
        if (!plan) return res.status(400).json({ error: 'Plano inválido' });

        const order = {
            id: `ord_${Date.now()}_${String(user.username).replace(/[^a-zA-Z0-9_-]/g, '')}`,
            username: user.username,
            planId: plan.id,
            planName: plan.name,
            days: plan.days,
            price: plan.price,
            status: 'pending',
            method: getMpAccessToken() ? 'mercadopago_pix' : 'pix_manual',
            paymentId: null,
            createdAt: new Date().toISOString(),
            paidAt: null
        };

        // Mercado Pago PIX (PainelPro-style) — gera QR / copia-e-cola
        if (getMpAccessToken()) {
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
                    message: 'Escaneie o QR Code ou copie o código PIX. O acesso libera automático após o pagamento.'
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
                key: getPixKey() || null,
                name: PIX_NAME,
                city: PIX_CITY,
                amount: plan.price,
                amountLabel: formatBRL(plan.price),
                message: getPixKey()
                    ? `Faça o PIX de ${formatBRL(plan.price)} e aguarde a confirmação do admin.`
                    : 'Configure MP_ACCESS_TOKEN (Mercado Pago) ou PIX_KEY no servidor.'
            }
        });
    } catch (err) {
        console.error('order error', err);
        res.status(500).json({ error: err.message || 'Falha ao criar pagamento' });
    }
});

// Admin confirma pagamento e libera dias


// Consulta status do pagamento (polling no front — igual PainelPro verify)
app.get('/api/plans/order/:id/status', requireAuth, async (req, res) => {
    try {
        const order = getOrder(req.params.id);
        if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
        const user = req.userFull || getUser(req.user.username);
        if (!user) return res.status(401).json({ error: 'Não autenticado' });
        if (order.username !== user.username && !isAdminUser(user)) {
            return res.status(403).json({ error: 'Sem permissão' });
        }

        if (order.status === 'paid') {
            return res.json({ ok: true, status: 'paid', order });
        }

        // Mercado Pago: consulta API
        if (order.paymentId && getMpAccessToken()) {
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
        if (!paymentId || !getMpAccessToken()) return;
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


// Configuração de pagamento (somente admin)
app.get('/api/admin/payment-settings', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin)) return res.status(403).json({ error: 'Apenas admin' });
    const s = readSettings();
    const token = getMpAccessToken();
    res.json({
        ok: true,
        mpConfigured: !!token,
        mpAccessTokenMasked: token ? (token.slice(0, 12) + '…' + token.slice(-6)) : '',
        hasTokenSaved: !!(s.mpAccessToken),
        pixKey: getPixKey(),
        pixName: s.pixName || PIX_NAME,
        planPrices: {
            monthly: getPlanPrice('monthly', 29.9),
            quarterly: getPlanPrice('quarterly', 79.9),
            yearly: getPlanPrice('yearly', 249.9)
        }
    });
});

app.post('/api/admin/payment-settings', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin)) return res.status(403).json({ error: 'Apenas admin' });

    const body = req.body || {};
    const next = {};

    if (body.mpAccessToken !== undefined) {
        const tok = String(body.mpAccessToken || '').trim();
        // string vazia = não apaga; use clearMpToken: true para remover
        if (tok) next.mpAccessToken = tok;
    }
    if (body.clearMpToken === true) next.mpAccessToken = '';

    if (body.pixKey !== undefined) next.pixKey = String(body.pixKey || '').trim();
    if (body.pixName !== undefined) next.pixName = String(body.pixName || '').trim();

    if (body.planPrices && typeof body.planPrices === 'object') {
        const cur = readSettings().planPrices || {};
        next.planPrices = {
            ...cur,
            monthly: body.planPrices.monthly !== undefined ? Number(body.planPrices.monthly) : cur.monthly,
            quarterly: body.planPrices.quarterly !== undefined ? Number(body.planPrices.quarterly) : cur.quarterly,
            yearly: body.planPrices.yearly !== undefined ? Number(body.planPrices.yearly) : cur.yearly
        };
    }

    const saved = writeSettings(next);
    const token = getMpAccessToken();
    res.json({
        ok: true,
        mpConfigured: !!token,
        mpAccessTokenMasked: token ? (token.slice(0, 12) + '…' + token.slice(-6)) : '',
        pixKey: getPixKey(),
        planPrices: {
            monthly: getPlanPrice('monthly', 29.9),
            quarterly: getPlanPrice('quarterly', 79.9),
            yearly: getPlanPrice('yearly', 249.9)
        }
    });
});

app.post('/api/admin/confirm-order', requireAuth, (req, res) => {
    const admin = req.userFull || getUser(req.user.username);
    if (!isAdminUser(admin) && !(ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN)) {
        return res.status(403).json({ error: 'Apenas admin' });
    }
    const order = getOrder(req.body.orderId);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.status === 'paid') return res.json({ ok: true, order, message: 'Já estava pago' });
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
    if (!username || !days || days < 1) return res.status(400).json({ error: 'username e days obrigatórios' });
    const target = getUser(username);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
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
    const updateUuid = ensureUserUpdateUuid(user);

    // Preserve the external port (for example :2000) in all generated URLs.
    const hostUrl = requestBaseUrl(req);
    const apkRelative = `/apks/${encodeURIComponent(user.username)}/app.apk`;
    const apkPath = path.join(APK_DIR, user.username, 'app.apk');
    const hasApk = fs.existsSync(apkPath);
    res.render('dashboard', {
        user: {
            ...req.user,
            email: user.email || '',
            updateUuid,
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
        updateUrl: buildUpdateEntryUrl(req, updateUuid),
        updateConfigUrl: buildPublicResourceUrl(req, updateUuid, 'config', '/u'),
        updateAppUpdateUrl: buildPublicResourceUrl(req, updateUuid, 'appupdate', '/u'),
        updateSmsUrl: buildPublicResourceUrl(req, updateUuid, 'sms', '/u'),
        updateThemeUrl: buildPublicResourceUrl(req, updateUuid, 'theme', '/u'),
        apkUrl: hasApk ? `${hostUrl}${apkRelative}` : '',
        hasApk
    });
});

// Upload do APK do aplicativo (atualizaÃ§Ã£o)
app.post('/api/apk/upload', requireAuth, requireActivePlanApi, (req, res) => {
    apkUpload.single('apk')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Falha no upload do APK' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const user = getUser(req.user.username);
        if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });

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
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
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
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    res.json({
        urls: getCdnPool(user),
        results: Array.isArray(user.cdn_pool_results) ? user.cdn_pool_results : [],
        active: Array.isArray(user.cdn_pool_active) ? user.cdn_pool_active : [],
        testedAt: user.cdn_pool_tested_at || null
    });
});

app.post('/api/cdn-pool', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const urls = parseCdnInput(req.body.urls);
    user.cdn_pool = urls;
    saveUser(user.username, user);
    res.json({ urls });
});

app.post('/api/cdn-pool/test', requireAuth, requireActivePlanApi, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const urls = parseCdnInput(
        Array.isArray(req.body.urls) && req.body.urls.length
            ? req.body.urls
            : getCdnPool(user)
    );
    const results = await Promise.all(urls.map(testCdnUrl));
    const active = results.filter(item => item.online).map(item => item.url);
    // Guarda o Ãºltimo teste para nÃ£o sumir ao recarregar/relogar
    user.cdn_pool_results = results;
    user.cdn_pool_active = active;
    user.cdn_pool_tested_at = new Date().toISOString();
    saveUser(user.username, user);
    res.json({ results, active, testedAt: user.cdn_pool_tested_at });
});

app.delete('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const target = normalizeCdnUrl(req.body.url);
    user.cdn_pool = getCdnPool(user).filter(url => url !== target);
    saveUser(user.username, user);
    res.json({ urls: user.cdn_pool });
});

function normalizeConfigPayload(nextConfig, currentConfig = null) {
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

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function asVersionNumber(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? number : fallback;
}

function getConfigVersionPayload(config) {
    return {
        UdpPort: String(config?.UdpPort ?? '7300'),
        Contato: String(config?.Contato ?? ''),
        Site: String(config?.Site ?? ''),
        Servers: Array.isArray(config?.Servers) ? config.Servers : []
    };
}

function getSmsVersionPayload(config) {
    const sms = (config?.Sms && typeof config.Sms === 'object') ? config.Sms : {};
    return {
        Update: String(sms.Update ?? ''),
        Notes: String(sms.Notes ?? '')
    };
}

function getThemeVersionPayload(config) {
    const theme = (config?.Theme && typeof config.Theme === 'object') ? { ...config.Theme } : {};
    delete theme.Version;
    delete theme.Update;
    return theme;
}

function applyAutomaticVersions(currentConfig, nextConfig) {
    if (!currentConfig) return nextConfig;

    const configChanged = stableSerialize(getConfigVersionPayload(currentConfig))
        !== stableSerialize(getConfigVersionPayload(nextConfig));
    const smsChanged = stableSerialize(getSmsVersionPayload(currentConfig))
        !== stableSerialize(getSmsVersionPayload(nextConfig));
    const themeChanged = stableSerialize(getThemeVersionPayload(currentConfig))
        !== stableSerialize(getThemeVersionPayload(nextConfig));

    nextConfig.Version = configChanged
        ? asVersionNumber(currentConfig.Version) + 1
        : asVersionNumber(currentConfig.Version);

    const currentSmsVersion = asVersionNumber(currentConfig.Sms?.Version);
    nextConfig.Sms.Version = String(smsChanged ? currentSmsVersion + 1 : currentSmsVersion);

    const currentThemeVersion = asVersionNumber(currentConfig.Theme?.Version);
    nextConfig.Theme.Version = String(themeChanged ? currentThemeVersion + 1 : currentThemeVersion);

    return nextConfig;
}

// Save completo — versões de config, tema e SMS sobem automaticamente. O APK continua manual.
app.post('/dashboard/save', requireAuth, requireActivePlanApi, (req, res) => {
    const { config_json } = req.body;
    try {
        const user = getUser(req.user.username);
        if (!user) return res.status(500).send('Erro ao salvar as configurações');
        const currentConfig = parseUserConfig(user);
        const nextConfig = applyAutomaticVersions(
            currentConfig,
            normalizeConfigPayload(JSON.parse(config_json))
        );
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
        res.status(400).send('Formato JSON invÃ¡lido');
    }
});

// Rotas legadas de SMS e tema: também calculam a versão automaticamente.
app.post('/api/sms', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    const body = req.body || {};
    const nextSms = {
        Version: String(config.Sms?.Version ?? '1'),
        Update: String(body.Update ?? config.Sms?.Update ?? ''),
        Notes: String(body.Notes ?? config.Sms?.Notes ?? '')
    };
    const smsChanged = stableSerialize(getSmsVersionPayload(config))
        !== stableSerialize(getSmsVersionPayload({ ...config, Sms: nextSms }));
    nextSms.Version = String(smsChanged ? asVersionNumber(config.Sms?.Version) + 1 : asVersionNumber(config.Sms?.Version));
    config.Sms = nextSms;
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true, Sms: config.Sms });
});

app.post('/api/theme', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const nextTheme = {
        ...((config.Theme && typeof config.Theme === 'object') ? config.Theme : {}),
        ...body,
        Version: String(config.Theme?.Version ?? '1'),
        AppName: 'ConnectPlus'
    };
    const themeChanged = stableSerialize(getThemeVersionPayload(config))
        !== stableSerialize(getThemeVersionPayload({ ...config, Theme: nextTheme }));
    nextTheme.Version = String(themeChanged ? asVersionNumber(config.Theme?.Version) + 1 : asVersionNumber(config.Theme?.Version));
    config.Theme = nextTheme;
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true, Theme: config.Theme });
});

// Exportar configuraÃ§Ã£o completa
app.get('/api/config/export', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    res.setHeader('Content-Disposition', `attachment; filename="c5g-config-${user.username}.json"`);
    res.type('application/json').send(JSON.stringify(config, null, 2));
});

function normalizeImportedList(value) {
    if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map((item) => String(item)).join('#');
    if (value === null || value === undefined) return '';
    return String(value);
}

function normalizeImportedPayload(value) {
    return String(value ?? '')
        .replace(/\\r\\n/g, '[lf]')
        .replace(/\\n/g, '[lf]')
        .replace(/\\r/g, '[lf]')
        .replace(/\r?\n/g, '[lf]')
        .replace(/\[crlf\]/gi, '[lf]')
        .replace(/\[cr\]/gi, '[lf]');
}

function mapImportedMode(mode) {
    const normalized = String(mode ?? '').trim().toUpperCase();
    const map = {
        SSH_DIRECT: 'Direct',
        SSH_PROXY: 'Proxy',
        SSL_DIRECT: 'Ssl',
        SSL_PROXY: 'Tlsws',
        DIRECT: 'Direct',
        PROXY: 'Proxy',
        SSL: 'Ssl',
        TLSWS: 'Tlsws',
        XHTTP: 'XHTTP'
    };
    return map[normalized] || 'Direct';
}

function normalizeImportedTls(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return ['TLSV1.3', 'TLSV1.2', 'TLSV1.1'].includes(normalized)
        ? normalized.replace('TLSV', 'TLSv')
        : 'TLSv1.2';
}

function convertExternalServer(item, index) {
    const source = item && typeof item === 'object' ? item : {};
    const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
    const category = source.category && typeof source.category === 'object' ? source.category : {};
    const payload = source.config_payload && typeof source.config_payload === 'object' ? source.config_payload : {};
    const server = source.server && typeof source.server === 'object' ? source.server : {};
    const proxy = source.proxy && typeof source.proxy === 'object' ? source.proxy : {};
    const mode = mapImportedMode(source.mode);
    const categoryColor = String(category.color || '#0000ff').replace(/([A-Fa-f0-9]{6})[A-Fa-f0-9]{2}$/, '$1');

    return {
        Name: String(source.name || `Servidor ${index + 1}`),
        ColorName: categoryColor,
        Description: String(source.description || category.name || ''),
        ColorDescription: categoryColor,
        FLAG: String(source.icon || ''),
        ServerIP: normalizeImportedList(server.host),
        ServerPort: String(server.port ?? '443'),
        CheckUser: String(source.url_check_user || ''),
        USER: String(auth.username ?? ''),
        PASS: String(auth.password ?? ''),
        Payload: normalizeImportedPayload(payload.payload),
        ProxyIP: normalizeImportedList(proxy.host),
        ProxyPort: String(proxy.port ?? '443'),
        SNI: String(payload.sni ?? ''),
        Path: '',
        TLSVersion: normalizeImportedTls(source.tls_version),
        Color: categoryColor,
        Info: mode
    };
}

function convertExternalConfig(incoming) {
    let items = incoming;
    if (incoming && !Array.isArray(incoming) && typeof incoming === 'object') {
        items = incoming.servers || incoming.Servers || incoming.configs || incoming.profiles || incoming.items;
    }
    if (!Array.isArray(items)) return { config: incoming, summary: null };

    const servers = items.map(convertExternalServer);
    const firstUdpPort = items
        .flatMap((item) => Array.isArray(item?.udp_ports) ? item.udp_ports : [])
        .find((port) => port !== null && port !== undefined && String(port).trim() !== '');
    const firstCategory = items.find((item) => item?.category?.name)?.category?.name;
    const summary = {
        source: 'external-array',
        imported: servers.length,
        modes: servers.reduce((acc, server) => { acc[server.Info] = (acc[server.Info] || 0) + 1; return acc; }, {}),
        udpPort: firstUdpPort !== undefined ? String(firstUdpPort) : null,
        category: firstCategory || null,
        warnings: []
    };
    if (items.some((item) => Array.isArray(item?.udp_ports) && item.udp_ports.length > 1)) {
        summary.warnings.push('O painel usa uma única UdpPort global; foi importada a primeira porta encontrada.');
    }
    if (items.some((item) => item?.config_v2ray || item?.config_openvpn)) {
        summary.warnings.push('Configurações V2Ray/OpenVPN não possuem equivalente no formato ConnectPlus e foram ignoradas.');
    }
    return {
        config: {
            Servers: servers,
            UdpPort: firstUdpPort !== undefined ? String(firstUdpPort) : undefined,
            Contato: '',
            Site: '',
            Version: 1,
            AppVersion: 1,
            VersionName: '1',
            UpdateApk: '',
            Actualization: 'false',
            Sms: { Version: '1', Update: '', Notes: '' },
            Theme: { Version: '1', AppName: 'ConnectPlus' }
        },
        summary
    };
}

// Importar configuraÃ§Ã£o completa e converter arrays do formato externo.
app.post('/api/config/import', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    try {
        let incoming = req.body;
        if (incoming && incoming.config_json) {
            incoming = typeof incoming.config_json === 'string'
                ? JSON.parse(incoming.config_json)
                : incoming.config_json;
        }
        if (typeof incoming === 'string') incoming = JSON.parse(incoming);
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ error: 'JSON invÃ¡lido' });
        }
        const currentConfig = parseUserConfig(user);
        const converted = convertExternalConfig(incoming);
        const candidateConfig = converted.summary
            ? {
                ...currentConfig,
                ...converted.config,
                AppVersion: currentConfig.AppVersion,
                VersionName: currentConfig.VersionName,
                UpdateApk: currentConfig.UpdateApk,
                Actualization: currentConfig.Actualization,
                Contato: currentConfig.Contato,
                Site: currentConfig.Site,
                Sms: currentConfig.Sms,
                Theme: currentConfig.Theme
            }
            : converted.config;
        const nextConfig = applyAutomaticVersions(currentConfig, normalizeConfigPayload(candidateConfig));
        user.config_json = JSON.stringify(nextConfig, null, 2);
        saveUser(user.username, user);
        res.json({ ok: true, config: nextConfig, importSummary: converted.summary });
    } catch (e) {
        res.status(400).json({ error: 'JSON invÃ¡lido' });
    }
});

function sendDynamicJson(res, payload) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    return res.type('application/json').send(payload);
}

// Resolvedor unificado: o aplicativo precisa conhecer apenas o UUID.
app.get('/u/:uuid', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).json({ error: 'UUID de atualização não encontrado' });
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildUpdateManifest(req, uuid, user));
});

app.get('/u/:uuid/config', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildUserConfig(req, uuid, user, '/u'));
});

app.get('/u/:uuid/appupdate', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildAppUpdate(req, uuid, user, '/u'));
});

app.get('/u/:uuid/sms', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildSmsPayload(user));
});

app.get('/u/:uuid/theme', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildThemePayload(req, uuid, user, '/u'));
});

// Endpoints pÃºblicos no formato esperado pelo aplicativo (legado).
app.get('/:username/config', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildUserConfig(req, username, user));
});

app.get('/:username/appupdate', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildAppUpdate(req, username, user));
});

app.get('/:username/sms', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildSmsPayload(user));
});

app.get('/:username/theme', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildThemePayload(req, username, user));
});
console.log('Mercado Pago:', (typeof getMpAccessToken === 'function' && getMpAccessToken()) ? 'CONFIGURADO' : 'NÃO configurado (modo PIX manual)');

app.listen(PORT, '0.0.0.0', () => {
    console.log(`C5G Panel listening on port ${PORT}`);
    void verifySmtpConfiguration();
});
