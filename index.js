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

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Pasta pública para APKs por usuário
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

// Recursos de atualização do aplicativo. Os arquivos ficam em public/updates
// para que possam ser substituídos sem misturar dados privados dos usuários.
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
        // Mantém apenas o contrato ConnectPlus e metadados internos necessários ao painel.
        const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'Theme', 'Servers'];
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
        return config;
    } catch (error) {
        return { Version: 1, UdpPort: '7300', Contato: '', Site: '', Servers: [] };
    }
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

    // O endpoint público segue exclusivamente o modelo ConnectPlus enviado.
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
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recurso não encontrado' });
        res.type('application/json').sendFile(file);
    });
}

app.get('/updates/manifest.json', (req, res) => {
    const manifest = path.join(__dirname, 'public', 'updates', 'manifest.json');
    if (!fs.existsSync(manifest)) return res.status(404).json({ error: 'Manifesto não encontrado' });
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
    // Login aceita usuário ou e-mail
    if (value.includes('@')) return findUserByEmail(value);
    return getUser(value);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
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
        if (!target) throw new Error('URL inválida');
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
        req.user = decoded;
        next();
    });
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

    if (!user) return res.render('login', { error: 'Usuário/e-mail ou senha inválidos' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'Usuário/e-mail ou senha inválidos' });

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
        return res.render('register', { error: 'Preencha usuário, e-mail e senha' });
    }

    if (!/^[a-zA-Z0-9]+$/.test(username)) {
        return res.render('register', { error: 'Usuário deve ser alfanumérico (sem espaços)' });
    }

    if (!isValidEmail(email)) {
        return res.render('register', { error: 'E-mail inválido' });
    }

    if (password.length < 6) {
        return res.render('register', { error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    try {
        if (getUser(username)) {
            return res.render('register', { error: 'Nome de usuário já existe' });
        }
        if (findUserByEmail(email)) {
            return res.render('register', { error: 'E-mail já cadastrado' });
        }

        const hash = await bcrypt.hash(password, 10);
        const configJsonStr = JSON.stringify(DEFAULT_CONFIG, null, 2);

        saveUser(username, {
            id: Date.now(),
            username,
            email,
            password: hash,
            config_json: configJsonStr,
            created_at: new Date().toISOString()
        });
        res.redirect('/login');
    } catch (e) {
        res.render('register', { error: 'Erro no servidor' });
    }
});

// Perfil do usuário logado
app.get('/api/profile', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
        username: user.username,
        email: user.email || '',
        created_at: user.created_at || null
    });
});

app.post('/api/profile', requireAuth, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const email = String(req.body.email || '').trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (email) {
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'E-mail inválido' });
        }
        const other = findUserByEmail(email);
        if (other && other.username !== user.username) {
            return res.status(400).json({ error: 'E-mail já está em uso por outra conta' });
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
            return res.status(400).json({ error: 'Nova senha deve ter no mínimo 6 caracteres' });
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

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
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
            created_at: user.created_at || null
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

// Upload do APK do aplicativo (atualização)
app.post('/api/apk/upload', requireAuth, (req, res) => {
    apkUpload.single('apk')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Falha no upload do APK' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const user = getUser(req.user.username);
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

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
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
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
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
        urls: getCdnPool(user),
        results: Array.isArray(user.cdn_pool_results) ? user.cdn_pool_results : [],
        active: Array.isArray(user.cdn_pool_active) ? user.cdn_pool_active : [],
        testedAt: user.cdn_pool_tested_at || null
    });
});

app.post('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const urls = parseCdnInput(req.body.urls);
    user.cdn_pool = urls;
    saveUser(user.username, user);
    res.json({ urls });
});

app.post('/api/cdn-pool/test', requireAuth, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const urls = parseCdnInput(
        Array.isArray(req.body.urls) && req.body.urls.length
            ? req.body.urls
            : getCdnPool(user)
    );
    const results = await Promise.all(urls.map(testCdnUrl));
    const active = results.filter(item => item.online).map(item => item.url);
    // Guarda o último teste para não sumir ao recarregar/relogar
    user.cdn_pool_results = results;
    user.cdn_pool_active = active;
    user.cdn_pool_tested_at = new Date().toISOString();
    saveUser(user.username, user);
    res.json({ results, active, testedAt: user.cdn_pool_tested_at });
});

app.delete('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const target = normalizeCdnUrl(req.body.url);
    user.cdn_pool = getCdnPool(user).filter(url => url !== target);
    saveUser(user.username, user);
    res.json({ urls: user.cdn_pool });
});

app.post('/dashboard/save', requireAuth, (req, res) => {
    const { config_json } = req.body;
    try {
        const nextConfig = JSON.parse(config_json);
        const user = getUser(req.user.username);
        if (user) {
            // Nunca auto-incrementa. Mantém exatamente o que veio do painel.
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
            const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'Theme', 'Servers'];
            Object.keys(nextConfig).forEach((key) => {
                if (!allowedRootKeys.includes(key)) delete nextConfig[key];
            });
            nextConfig.UdpPort = String(nextConfig.UdpPort ?? '7300');
            nextConfig.Contato = String(nextConfig.Contato ?? '');
            nextConfig.Site = String(nextConfig.Site ?? '');
            user.config_json = JSON.stringify(nextConfig, null, 2);
            saveUser(user.username, user);
            return res.json({
                ok: true,
                Version: nextConfig.Version,
                AppVersion: nextConfig.AppVersion,
                VersionName: nextConfig.VersionName,
                Actualization: nextConfig.Actualization,
                UpdateApk: nextConfig.UpdateApk
            });
        } else {
            res.status(500).send('Erro ao salvar as configurações');
        }
    } catch (e) {
        res.status(400).send('Formato JSON inválido');
    }
});

// Endpoints públicos no formato esperado pelo aplicativo.
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
    const config = buildUserConfig(req, username, user);
    res.type('application/json').send({ Version: String(config.Version ?? 1), Update: config.Sms });
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
