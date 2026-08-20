const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 2000);
const JWT_SECRET = 'super_secret_c5g_key_for_testing';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Recursos de atualização do aplicativo. Os arquivos ficam em public/updates
// para que possam ser substituídos sem misturar dados privados dos usuários.
const UPDATE_RESOURCES = {
    appupdate: 'appupdate',
    config: 'config',
    sms: 'sms',
    theme: 'theme'
};

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
    "PainelConecta5G": false,
    "ReleaseNotes": "NOVA ATUALIZAÇÃO DISPONÍVEL!",
    "UrlUpdate": "https://paste.blume.net.br/raw/500",
    "Sms": "http://c5g.dtmod.shop/update/pasta_DasDasilva/sms",
    "logoonline": "https://i.ibb.co/1GFWft65/ic-banner.png",
    "fundoonline": "https://i.ibb.co/Pz189Nvw/77bb3128f92f68bbf7e4e38156078416.jpg",
    "banneRodapeOnline": "",
    "fundoDoLogOnline": "",
    "EmailFeedback": "",
    "UrlContato": "",
    "UrlTermos": "",
    "CheckUser": "false",
    "ModderLinkWhatsapp": "",
    "ModderLinkTelegram": "",
    "ModderCorCaixaServ": false,
    "ModderCorCaixaPay": false,
    "ModderCorCaixaCentral": false,
    "ModderCorCaixaConexao": false,
    "ModderCorCaixaRegistro": false,
    "ModderCorCaixaFerramentas": false,
    "ModderCorCaixaUsuario": false,
    "ModderCorCaixaSenha": false,
    "ModderCorBotaoIniciar": false,
    "ModderCorBotaoLog": false,
    "ModderCorBotaoConfig": false,
    "DnsPrimario": "8.8.8.8",
    "DnsSecundario": "8.4.4.8",
    "Udp": [
        {
            "Porta": "7300"
        }
    ],
    "Servers": [
        {
            "Name": "Servidor Br 1",
            "TYPE": "free",
            "FLAG": "br.png",
            "ServerIP": "br1.beto02.shop",
            "CheckUser": "http://",
            "ServerPort": "22",
            "SSLPort": "443",
            "USER": "",
            "PASS": ""
        }
    ]
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
    const user = getUser(username);
    
    if (!user) return res.render('login', { error: 'Usuário ou senha inválidos' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'Usuário ou senha inválidos' });
    
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('auth_token', token).redirect('/dashboard');
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.render('register', { error: 'Todos os campos são obrigatórios' });
    
    // Check alpha numeric username
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
        return res.render('register', { error: 'Usuário deve ser alfanumérico' });
    }

    try {
        if (getUser(username)) {
            return res.render('register', { error: 'Nome de usuário já existe' });
        }

        const hash = await bcrypt.hash(password, 10);
        const configJsonStr = JSON.stringify(DEFAULT_CONFIG, null, 2);
        
        saveUser(username, {
            id: Date.now(),
            username,
            password: hash,
            config_json: configJsonStr
        });
        res.redirect('/login');
    } catch (e) {
        res.render('register', { error: 'Erro no servidor' });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_token').redirect('/login');
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.redirect('/login');
    
    // Determine network ip or localhost
    const scheme = req.protocol;
    const hostUrl = req.hostname === 'localhost' || req.hostname === '127.0.0.1' ? `${scheme}://${req.hostname}:${PORT}` : `${scheme}://${req.hostname}`;
    
    res.render('dashboard', { 
        user: req.user, 
        configStr: user.config_json,
        appUrl: `${hostUrl}/${user.username}/config`
    });
});

app.post('/dashboard/save', requireAuth, (req, res) => {
    const { config_json } = req.body;
    try {
        // Validate JSON
        JSON.parse(config_json);
        const user = getUser(req.user.username);
        if (user) {
            user.config_json = config_json;
            saveUser(user.username, user);
            res.redirect('/dashboard');
        } else {
            res.status(500).send('Erro ao salvar as configurações');
        }
    } catch (e) {
        res.status(400).send('Formato JSON inválido');
    }
});

// Public Config Endpoint for the app
app.get('/:username/config', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    res.setHeader('Content-Type', 'application/json');
    res.send(user.config_json);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`C5G Panel listening on port ${PORT}`);
});
