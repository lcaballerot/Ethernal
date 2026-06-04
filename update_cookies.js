#!/usr/bin/env node
/**
 * Ethernal Cookie Updater — Multiplataforma (Windows + Linux)
 *
 * Extrae las cookies de YouTube de tu navegador instalado usando yt-dlp,
 * las verifica, las sube al servidor AWS por SSH y reinicia el contenedor.
 *
 * Uso:
 *   node update_cookies.js                  — selector interactivo de navegador
 *   node update_cookies.js chrome           — extraer de Chrome directamente
 *   node update_cookies.js opera --no-upload — extraer solo, sin subir
 *   node update_cookies.js --help           — mostrar ayuda
 *
 * Navegadores: chrome, firefox, edge, opera, brave, chromium, vivaldi, safari
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ─── Configuración ───────────────────────────────────────────────
const CONFIG = {
    sshHost: 'REDACTED',
    sshUser: 'ubuntu',
    // Define la ruta de tu clave SSH con la variable de entorno ETHERNAL_SSH_KEY
    sshKeyPath: process.env.ETHERNAL_SSH_KEY || (os.platform() === 'win32'
        ? path.join('C:', 'Users', 'SysAdmin', 'Desktop', 'TheHubClub', '[REDACTADO].pem')
        : path.join(os.homedir(), '.ssh', '[REDACTADO].pem')),
    remotePath: '/home/ubuntu/ethernal-stack/',
    containerName: 'ethernal-bot',
};

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const BROWSERS = ['chrome', 'firefox', 'edge', 'opera', 'brave', 'chromium', 'vivaldi', 'safari'];

// Ruta de yt-dlp multiplataforma (misma lógica que index.js)
const ytdlpPath = os.platform() === 'win32'
    ? path.join(__dirname, 'yt-dlp.exe')
    : 'yt-dlp';

// ─── Ayudantes ───────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const PURPLE = '\x1b[35m';

function log(icon, msg) { console.log(`  ${icon}  ${msg}`); }
function logOk(msg)      { log(`${GREEN}✔${RESET}`, msg); }
function logFail(msg)    { log(`${RED}✖${RESET}`, msg); }
function logWarn(msg)    { log(`${YELLOW}⚠${RESET}`, msg); }
function logInfo(msg)    { log(`${CYAN}→${RESET}`, msg); }

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function showHelp() {
    console.log(`
${BOLD}Ethernal Cookie Updater${RESET} — Extrae y sincroniza cookies de YouTube

${BOLD}Uso:${RESET}
  node update_cookies.js [navegador] [opciones]

${BOLD}Navegadores:${RESET}
  ${BROWSERS.join(', ')}

${BOLD}Opciones:${RESET}
  --no-upload    Extraer cookies solo, no subir al servidor
  --no-restart   Subir pero no reiniciar el contenedor del bot
  --help         Mostrar esta ayuda

${BOLD}Ejemplos:${RESET}
  node update_cookies.js                  Modo interactivo
  node update_cookies.js chrome           Extraer de Chrome
  node update_cookies.js opera --no-upload  Extraer solo
`);
}

// ─── Paso 1: Extraer cookies del navegador ───────────────────────
function extractCookies(browser) {
    logInfo(`Extrayendo cookies de ${BOLD}${browser}${RESET}...`);

    try {
        execFileSync(ytdlpPath, [
            '--cookies-from-browser', browser,
            '--cookies', COOKIES_FILE,
            '--skip-download',
            '--no-warnings',
            '--quiet',
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        ], { timeout: 30000, stdio: 'pipe' });

        if (fs.existsSync(COOKIES_FILE)) {
            const content = fs.readFileSync(COOKIES_FILE, 'utf8');
            const cookieCount = content.split('\n').filter(l => l && !l.startsWith('#') && l.includes('\t')).length;
            logOk(`Extraídas ${BOLD}${cookieCount}${RESET} cookies → ${DIM}cookies.txt${RESET}`);
            return true;
        }
    } catch (e) {
        const stderr = e.stderr?.toString() || e.message;
        if (stderr.includes('could not find') || stderr.includes('not available')) {
            logFail(`Navegador ${BOLD}${browser}${RESET} no encontrado en este sistema.`);
        } else if (stderr.includes('locked') || stderr.includes('in use')) {
            logFail(`No se pueden leer las cookies — cierra ${BOLD}${browser}${RESET} primero y reintenta.`);
        } else {
            logFail(`Falló la extracción: ${stderr.slice(-200)}`);
        }
    }
    return false;
}

// ─── Paso 2: Verificar que las cookies funcionan ─────────────────
function verifyCookies() {
    logInfo('Verificando cookies con una búsqueda de prueba...');

    try {
        const result = execFileSync(ytdlpPath, [
            '--cookies', COOKIES_FILE,
            '--dump-json',
            '--no-download',
            '--no-warnings',
            '--force-ipv4',
            '--no-check-certificates',
            'ytsearch1:never gonna give you up',
        ], { timeout: 45000, maxBuffer: 10 * 1024 * 1024 });

        const info = JSON.parse(result.toString().split('\n')[0]);
        logOk(`Las cookies funcionan — encontrado: ${BOLD}"${info.title}"${RESET}`);
        return true;
    } catch (e) {
        logWarn('Falló la verificación — las cookies podrían funcionar igualmente, pero pueden estar caducadas.');
        return false;
    }
}

// ─── Paso 3: Subir al servidor por SSH ───────────────────────────
async function uploadToServer() {
    logInfo(`Subiendo a ${BOLD}${CONFIG.sshHost}${RESET}...`);

    // Comprobar que la clave SSH existe
    if (!fs.existsSync(CONFIG.sshKeyPath)) {
        logFail(`Clave SSH no encontrada: ${CONFIG.sshKeyPath}`);
        logInfo(`Define la variable ${BOLD}ETHERNAL_SSH_KEY${RESET} o coloca la clave en la ruta esperada.`);
        return false;
    }

    try {
        const { Client } = require('ssh2');

        return new Promise((resolve) => {
            const conn = new Client();

            conn.on('ready', () => {
                logOk('SSH conectado.');

                // Subir cookies.txt por SFTP
                conn.sftp((err, sftp) => {
                    if (err) { logFail(`Error SFTP: ${err.message}`); conn.end(); resolve(false); return; }

                    const remoteCookies = CONFIG.remotePath + 'cookies.txt';
                    const localData = fs.readFileSync(COOKIES_FILE);

                    sftp.writeFile(remoteCookies, localData, (err) => {
                        if (err) {
                            logFail(`Falló la subida: ${err.message}`);
                            conn.end();
                            resolve(false);
                            return;
                        }

                        logOk(`Subido ${BOLD}cookies.txt${RESET} → ${DIM}${remoteCookies}${RESET}`);
                        conn.end();
                        resolve(true);
                    });
                });
            });

            conn.on('error', (err) => {
                logFail(`Falló la conexión SSH: ${err.message}`);
                resolve(false);
            });

            conn.connect({
                host: CONFIG.sshHost,
                port: 22,
                username: CONFIG.sshUser,
                privateKey: fs.readFileSync(CONFIG.sshKeyPath),
            });
        });
    } catch (e) {
        logFail(`Error del módulo SSH: ${e.message}`);
        return false;
    }
}

// ─── Paso 4: Reiniciar el contenedor del bot ─────────────────────
async function restartBot() {
    logInfo(`Reiniciando ${BOLD}${CONFIG.containerName}${RESET} en el servidor...`);

    try {
        const { Client } = require('ssh2');

        return new Promise((resolve) => {
            const conn = new Client();

            conn.on('ready', () => {
                conn.exec(`sudo docker restart ${CONFIG.containerName}`, (err, stream) => {
                    if (err) { logFail(`Falló el comando de reinicio: ${err.message}`); conn.end(); resolve(false); return; }

                    let output = '';
                    stream.on('data', d => output += d.toString());
                    stream.stderr.on('data', d => output += d.toString());
                    stream.on('close', (code) => {
                        if (code === 0) {
                            logOk('Contenedor del bot reiniciado.');
                        } else {
                            logFail(`El reinicio salió con código ${code}: ${output.trim()}`);
                        }
                        conn.end();
                        resolve(code === 0);
                    });
                });
            });

            conn.on('error', (err) => {
                logFail(`Falló la conexión SSH: ${err.message}`);
                resolve(false);
            });

            conn.connect({
                host: CONFIG.sshHost,
                port: 22,
                username: CONFIG.sshUser,
                privateKey: fs.readFileSync(CONFIG.sshKeyPath),
            });
        });
    } catch (e) {
        logFail(`Error de reinicio: ${e.message}`);
        return false;
    }
}

// ─── Principal ───────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }

    const noUpload = args.includes('--no-upload');
    const noRestart = args.includes('--no-restart');
    const browserArg = args.find(a => !a.startsWith('--'));

    console.log(`\n${PURPLE}${BOLD}  ═══════════════════════════════════════${RESET}`);
    console.log(`${PURPLE}${BOLD}     Ethernal Cookie Updater v1.0${RESET}`);
    console.log(`${PURPLE}${BOLD}  ═══════════════════════════════════════${RESET}`);
    console.log(`  ${DIM}Plataforma: ${os.platform()} | yt-dlp: ${ytdlpPath}${RESET}\n`);

    // ── Elegir navegador ──
    let browser = browserArg;

    if (!browser || !BROWSERS.includes(browser.toLowerCase())) {
        console.log(`  ${BOLD}Navegadores disponibles:${RESET}`);
        BROWSERS.forEach((b, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${b}`));
        console.log('');
        const choice = await prompt(`  Selecciona navegador (nombre o número): `);

        if (/^\d+$/.test(choice)) {
            browser = BROWSERS[parseInt(choice) - 1];
        } else {
            browser = choice.toLowerCase();
        }
    } else {
        browser = browser.toLowerCase();
    }

    if (!BROWSERS.includes(browser)) {
        logFail(`Navegador desconocido: "${browser}"`);
        process.exit(1);
    }

    console.log('');

    // ── Extraer ──
    if (!extractCookies(browser)) {
        logFail('Falló la extracción de cookies.');
        process.exit(1);
    }

    // ── Verificar ──
    const verified = verifyCookies();

    if (!verified) {
        const proceed = await prompt(`\n  ¿Continuar de todos modos? (s/n): `);
        if (proceed.toLowerCase() !== 's' && proceed.toLowerCase() !== 'y') {
            logInfo('Abortado.');
            process.exit(0);
        }
    }

    // ── Subir ──
    if (!noUpload) {
        console.log('');
        const uploaded = await uploadToServer();

        if (uploaded && !noRestart) {
            const doRestart = await prompt(`\n  ¿Reiniciar el contenedor del bot? (s/n): `);
            if (doRestart.toLowerCase() === 's' || doRestart.toLowerCase() === 'y') {
                await restartBot();
            }
        }
    } else {
        logInfo('Omitiendo subida (--no-upload).');
    }

    console.log(`\n  ${GREEN}${BOLD}¡Listo!${RESET}\n`);
}

main().catch(e => {
    logFail(`Fatal: ${e.message}`);
    process.exit(1);
});
