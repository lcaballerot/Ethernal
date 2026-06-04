const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActivityType, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionFlagsBits, AuditLogEvent, ChannelType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    StreamType,
    entersState
} = require('@discordjs/voice');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mongoose = require('mongoose');
const https = require('https');

const OWNER_ID = '859655019946704926';

const premiumSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    isPremium: { type: Boolean, default: false }
});
const PremiumUser = mongoose.model('PremiumUser', premiumSchema);



// Multiplataforma: binarios incluidos en Windows, binarios del sistema en Linux
const isWindows = os.platform() === 'win32';
let ffmpegPath, ytdlpPath;

if (isWindows) {
    ffmpegPath = require('ffmpeg-static');
    ytdlpPath = path.join(__dirname, 'yt-dlp.exe');
    if (ffmpegPath) {
        process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;
    }
} else {
    ffmpegPath = 'ffmpeg';
    ytdlpPath = 'yt-dlp';
}
console.log(`[Boot] Plataforma: ${os.platform()} | FFmpeg: ${ffmpegPath} | yt-dlp: ${ytdlpPath}`);

// ─── Directorio temporal de descargas ─────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'ethernal-music');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log(`[Boot] Directorio temporal: ${TEMP_DIR}`);

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// ─── Capturar errores no controlados para evitar caídas ───────────
process.on('unhandledRejection', (err) => {
    console.error('[Rechazo no controlado]:', err?.message || err);
});

// Cargar token
let TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    const candidates = [
        path.join(__dirname, 'res', 'BOT_TOKEN.md'),
        path.join(__dirname, 'res', 'BOT_TOKEN.txt'),
    ];
    for (const tokenPath of candidates) {
        try {
            TOKEN = fs.readFileSync(tokenPath, 'utf8').trim();
            if (TOKEN) break;
        } catch (err) { /* probar siguiente */ }
    }
    if (!TOKEN) {
        console.error('[Fatal] No hay variable DISCORD_TOKEN ni archivo de token en res/');
        process.exit(1);
    }
}
console.log('[Boot] Token cargado.');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildInvites,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
});

const queue = new Map();

// ─── Sistema de diseño ────────────────────────────────────────────
const THEME = {
    primary: 0x9B59B6,   // Púrpura intenso
    accent: 0x2ECC71,   // Verde esmeralda
    warning: 0xE67E22,   // Naranja cálido
    danger: 0xE74C3C,   // Rojo limpio
    info: 0x3498DB,   // Azul acero
    muted: 0x95A5A6,   // Gris suave
    dark: 0x2C3E50,   // Pizarra oscura
};

const BAR = { filled: '▬', pointer: '🔘', empty: '▬' };

function makeProgressBar(length = 18) {
    const pos = Math.floor(Math.random() * (length - 2)) + 1;
    return '`' + BAR.filled.repeat(pos) + '`' + BAR.pointer + '`' + BAR.empty.repeat(length - pos - 1) + '`';
}

function fmt(text, maxLen = 45) {
    if (!text) return 'Desconocido';
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// ─── Registro de comandos slash ───────────────────────────────────
const slashCommands = [
    new SlashCommandBuilder().setName('play').setDescription('Reproduce una canción o la añade a la cola')
        .addStringOption(o => o.setName('query').setDescription('Nombre de la canción, URL o URL de playlist').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Salta la canción actual'),
    new SlashCommandBuilder().setName('stop').setDescription('Detiene la reproducción y limpia la cola'),
    new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola actual'),
    new SlashCommandBuilder().setName('np').setDescription('Muestra los detalles de lo que suena ahora'),
    new SlashCommandBuilder().setName('help').setDescription('Muestra los comandos del bot'),
    new SlashCommandBuilder().setName('ping').setDescription('Muestra la latencia del bot'),
    new SlashCommandBuilder().setName('premium').setDescription('Activa/desactiva premium para un usuario (solo dueño)')
        .addUserOption(o => o.setName('user').setDescription('Usuario a alternar').setRequired(true)),
    new SlashCommandBuilder().setName('loop').setDescription('Activa/desactiva el bucle de la canción actual (Premium)'),
    new SlashCommandBuilder().setName('volume').setDescription('Ajusta el volumen de reproducción (Premium)')
        .addIntegerOption(o => o.setName('level').setDescription('Volumen 0-100').setRequired(true).setMinValue(0).setMaxValue(100)),
    new SlashCommandBuilder().setName('speed').setDescription('Ajusta la velocidad de reproducción (Premium)')
        .addStringOption(o => o.setName('rate').setDescription('Velocidad (0.25-3.0), ej. 1.5 o 1,5').setRequired(true)),
    new SlashCommandBuilder().setName('pitch').setDescription('Ajusta el tono de reproducción (Premium)')
        .addStringOption(o => o.setName('level').setDescription('Tono (0.25-3.0), ej. 1.5 o 1,5').setRequired(true)),
    new SlashCommandBuilder().setName('set').setDescription('Salta a una posición de la canción actual (Premium)')
        .addStringOption(o => o.setName('time').setDescription('Tiempo ej. 1m30s, 2:30, 90').setRequired(true)),
    new SlashCommandBuilder().setName('jump').setDescription('Salta a un tiempo concreto de la canción actual (Premium)')
        .addStringOption(o => o.setName('time').setDescription('Tiempo ej. 4:36, 1:23:45, 2m30s').setRequired(true)),
    new SlashCommandBuilder().setName('tts').setDescription('Texto a voz en el canal de voz (Premium)')
        .addStringOption(o => o.setName('text').setDescription('Texto a decir').setRequired(true)),
    // ─── Moderación (Creador / Co-Owner) ───
    new SlashCommandBuilder().setName('warn').setDescription('Avisar a un miembro del servidor')
        .addUserOption(o => o.setName('target').setDescription('Miembro a avisar').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Razón del aviso').setRequired(true)),
    new SlashCommandBuilder().setName('warnings').setDescription('Ver el historial de avisos de un miembro')
        .addUserOption(o => o.setName('target').setDescription('Miembro a consultar').setRequired(true)),
    new SlashCommandBuilder().setName('clear-warnings').setDescription('Borrar todos los avisos de un miembro')
        .addUserOption(o => o.setName('target').setDescription('Miembro a limpiar').setRequired(true)),
    new SlashCommandBuilder().setName('kick').setDescription('Expulsar a un miembro del servidor')
        .addUserOption(o => o.setName('target').setDescription('Miembro a expulsar').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Banear a un miembro del servidor')
        .addUserOption(o => o.setName('target').setDescription('Miembro a banear').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(false))
        .addIntegerOption(o => o.setName('delete_messages').setDescription('Días de mensajes a borrar').setRequired(false)
            .setChoices({ name: 'No borrar', value: 0 }, { name: 'Últimas 24h', value: 1 }, { name: 'Últimos 7 días', value: 7 })),
    new SlashCommandBuilder().setName('mute').setDescription('Silenciar (timeout) a un miembro')
        .addUserOption(o => o.setName('target').setDescription('Miembro a silenciar').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duración (ej. 10m, 1h, 1d)').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(false)),
    new SlashCommandBuilder().setName('unmute').setDescription('Quitar el silencio (timeout) a un miembro')
        .addUserOption(o => o.setName('target').setDescription('Miembro a reactivar').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(false)),
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`[Boot] ${client.user.tag} está en línea.`);
    try {
        const mongoUrl = process.env.MONGO_URL || 'mongodb://ethernal-mongo:27017/ethernal';
        await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
        console.log('[Boot] MongoDB conectado.');
    } catch (e1) {
        console.error('[Boot] Falló la conexión a MongoDB:', e1.message);
    }

    client.user.setPresence({
        activities: [{
            name: '🎵 Ethernal | /play',
            type: ActivityType.Listening,
        }],
        status: 'online',
    });

    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
        console.log('[Boot] Comandos slash registrados.');
    } catch (e) {
        console.error('[Boot] Falló el registro de comandos slash:', e.message);
    }

    cleanupAllTemp();

    // ─── Limpieza periódica de temporales (cada 30 min) ──────────
    setInterval(() => {
        try {
            const files = fs.readdirSync(TEMP_DIR);
            const now = Date.now();
            let cleaned = 0;
            for (const f of files) {
                const fp = path.join(TEMP_DIR, f);
                try {
                    const stat = fs.statSync(fp);
                    // Borrar archivos de más de 30 minutos que no estén en ninguna cola
                    if (now - stat.mtimeMs > 30 * 60 * 1000) {
                        let inUse = false;
                        for (const [, sq] of queue) {
                            for (const s of sq.songs) {
                                if (s.filePath === fp) { inUse = true; break; }
                            }
                            if (inUse) break;
                        }
                        if (!inUse) { fs.unlinkSync(fp); cleaned++; }
                    }
                } catch { }
            }
            if (cleaned > 0) console.log(`[Limpieza] Periódica: eliminados ${cleaned} temporales obsoletos.`);
        } catch { }
    }, 30 * 60 * 1000);

    // ─── Auto-actualización semanal de yt-dlp ────────────────────
    if (!isWindows) {
        const updateYtdlp = () => {
            console.log('[yt-dlp] Buscando actualizaciones...');
            execFile(ytdlpPath, ['-U'], { timeout: 60000 }, (err, stdout) => {
                if (err) console.error('[yt-dlp] Falló la comprobación de actualización:', err.message);
                else console.log(`[yt-dlp] ${stdout.trim()}`);
            });
        };
        updateYtdlp(); // Comprobar al arrancar
        setInterval(updateYtdlp, 7 * 24 * 60 * 60 * 1000); // Comprobar semanalmente
    }
});

// ─── Ayudantes de archivos temporales ─────────────────────────────
function makeTempPath(guildId) {
    const id = crypto.randomBytes(6).toString('hex');
    return path.join(TEMP_DIR, `${guildId}_${id}.opus`);
}

function safeDelete(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.error(`[Limpieza] No se pudo borrar ${filePath}:`, err.message);
        else if (!err) console.log(`[Limpieza] Borrado ${filePath}`);
    });
}

function cleanupAllTemp() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
            fs.unlinkSync(path.join(TEMP_DIR, f));
        }
        if (files.length > 0) console.log(`[Limpieza] Purgados ${files.length} temporales sobrantes.`);
    } catch { }
}

const ICONS = {
    YouTube: 'https://cdn-icons-png.flaticon.com/512/1384/1384060.png',
    SoundCloud: 'https://cdn-icons-png.flaticon.com/512/145/145810.png'
};



// ─── Ayudante Premium ─────────────────────────────────────────────
async function isPremium(userId) {
    try {
        const user = await PremiumUser.findOne({ discordId: userId });
        return user?.isPremium === true;
    } catch { return false; }
}

function parseDecimal(str) {
    if (!str) return NaN;
    const clean = str.replace(',', '.');
    return parseFloat(clean);
}

function getCurrentPosition(sq) {
    if (!sq) return 0;
    if (!sq.playStartTime) return sq.playStartOffset || 0;
    const elapsed = (Date.now() - sq.playStartTime) / 1000;
    return sq.playStartOffset + elapsed * sq.speed;
}

function parseTimeStr(str) {
    if (!str) return 0;
    let secs = 0;
    // Formatos con dos puntos H:MM:SS o M:SS
    const hmsMatch = str.match(/^(\d+):(\d+):(\d+)$/);
    const msMatch = str.match(/^(\d+):(\d+)$/);
    const mMatch = str.match(/(\d+)\s*m/i);
    const sMatch = str.match(/(\d+)\s*s/i);
    const hMatch = str.match(/(\d+)\s*h/i);
    if (hmsMatch) {
        secs = parseInt(hmsMatch[1]) * 3600 + parseInt(hmsMatch[2]) * 60 + parseInt(hmsMatch[3]);
    } else if (msMatch) {
        secs = parseInt(msMatch[1]) * 60 + parseInt(msMatch[2]);
    } else if (hMatch || mMatch || sMatch) {
        if (hMatch) secs += parseInt(hMatch[1]) * 3600;
        if (mMatch) secs += parseInt(mMatch[1]) * 60;
        if (sMatch) secs += parseInt(sMatch[1]);
    } else {
        secs = parseInt(str) || 0;
    }
    return secs;
}

// ─── Argumentos base de yt-dlp (bypass de YouTube) ────────────────
function ytdlpBaseArgs(allowPlaylist = false) {
    const args = [
        '--no-warnings',
        '--force-ipv4',
        '--no-check-certificates',
    ];

    if (!allowPlaylist) args.push('--no-playlist');

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }

    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // Bypass de YouTube: GetPOT (Proof of Origin Token) vía manejador JSI + cookies
    args.push('--js-runtimes', `node:${isWindows ? 'node' : '/usr/local/bin/node'}`);
    args.push('--extractor-args', 'getpot:handler=jsi;youtube:player_client=android,web');

    return args;
}

// ─── Búsqueda vía yt-dlp ──────────────────────────────────────────
async function searchSong(query) {
    const isUrl = /^https?:\/\//.test(query);
    const isPlaylist = isUrl && (query.includes('list=') || query.includes('/sets/') || query.includes('/playlist/'));

    // Playlists: obtener SOLO la primera canción al instante, devolver marcador _playlist
    if (isPlaylist) {
        try {
            const firstSong = await ytdlpGetInfo(query, true, '1');
            if (firstSong && firstSong.length > 0) {
                let source = 'YouTube';
                if (firstSong[0].url?.includes('soundcloud.com')) source = 'SoundCloud';
                firstSong.forEach(r => { if (!r.source) r.source = source; });
                firstSong[0]._playlistUrl = query; // Marcar para carga en segundo plano
                return firstSong;
            }
        } catch (e) {
            console.log(`[Búsqueda] Falló la obtención de la primera canción de la playlist: ${e.message}`);
        }
    }

    const searches = [];
    if (isUrl) {
        searches.push(query);
    } else {
        searches.push(`ytsearch1:${query}`);
        searches.push(`scsearch1:${query}`);
    }

    for (const searchQuery of searches) {
        try {
            const results = await ytdlpGetInfo(searchQuery);
            if (results && results.length > 0) {
                let source = 'YouTube';
                if (searchQuery.startsWith('scsearch') || results[0].url?.includes('soundcloud.com')) {
                    source = 'SoundCloud';
                }
                results.forEach(r => { if (!r.source) r.source = source; });
                return results;
            }
        } catch (e) {
            const source = searchQuery.startsWith('ytsearch') ? 'YouTube' : searchQuery.startsWith('scsearch') ? 'SoundCloud' : 'Directo';
            console.log(`[Búsqueda] ${source} falló para "${query}": ${e.message}`);

            // Si una URL directa de YouTube falla, probar SoundCloud como respaldo
            if (isUrl && (query.includes('youtube.com') || query.includes('youtu.be'))) {
                console.log(`[Búsqueda] URL directa de YouTube falló, probando respaldo de SoundCloud para: ${query}`);
                const fallback = await ytdlpGetInfo(`scsearch1:${query}`).catch(() => null);
                if (fallback && fallback.length > 0) {
                    fallback.forEach(r => r.source = 'SoundCloud');
                    return fallback;
                }
            }
        }
    }

    return null;
}

function ytdlpGetInfo(query, allowPlaylist = false, playlistItems = null) {
    return new Promise((resolve, reject) => {
        const args = [...ytdlpBaseArgs(allowPlaylist), '--dump-json', '--no-download'];
        if (playlistItems) args.push('--playlist-items', playlistItems);
        args.push(query);
        const timeout = 45000;

        execFile(ytdlpPath, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(stderr?.slice(-300) || err.message));
            }
            try {
                const lines = stdout.trim().split('\n').filter(l => l.length > 0);
                const songs = lines.map(line => {
                    try {
                        const info = JSON.parse(line);
                        return {
                            title: info.title || info.fulltitle || 'Desconocido',
                            url: info.webpage_url || info.url || info.original_url,
                            duration: info.duration_string || (info.duration ? formatDuration(info.duration) : 'N/D'),
                            durationSecs: info.duration || 0,
                            thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : null),
                            channel: info.channel || info.uploader || info.artist || 'Desconocido',
                            filePath: null,
                        };
                    } catch (e) {
                        return null;
                    }
                }).filter(s => s && s.url);
                resolve(songs);
            } catch (e) {
                reject(new Error('No se pudo interpretar la salida de yt-dlp'));
            }
        });
    });
}

// ─── Cargador de playlist en segundo plano ────────────────────────
// Obtiene el resto de canciones con --flat-playlist (rápido, solo URL+título)
// luego resuelve metadatos uno a uno y los añade a la cola
async function loadPlaylistBackground(guildId, playlistUrl, firstSongUrl) {
    const sq = queue.get(guildId);
    if (!sq) return;

    try {
        console.log(`[Playlist] Cargando en segundo plano: ${playlistUrl}`);
        // Usar --flat-playlist para obtener solo URLs/títulos rápido (sin metadatos completos)
        const args = [
            ...ytdlpBaseArgs(true),
            '--flat-playlist', '--dump-json', '--no-download',
            '--playlist-items', '2:50', // Saltar la primera (ya sonando), tope 50
            playlistUrl
        ];

        const output = await new Promise((resolve, reject) => {
            execFile(ytdlpPath, args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout);
            });
        });

        const lines = output.trim().split('\n').filter(l => l.length > 0);
        let added = 0;

        for (const line of lines) {
            try {
                const info = JSON.parse(line);
                const url = info.webpage_url || info.url || info.original_url;
                if (!url || url === firstSongUrl) continue;

                const song = {
                    title: info.title || info.fulltitle || 'Desconocido',
                    url,
                    duration: info.duration_string || (info.duration ? formatDuration(info.duration) : 'N/D'),
                    durationSecs: info.duration || 0,
                    thumbnail: info.thumbnail || null,
                    channel: info.channel || info.uploader || info.artist || 'Desconocido',
                    source: url.includes('soundcloud.com') ? 'SoundCloud' : 'YouTube',
                    filePath: null,
                };

                const currentQ = queue.get(guildId);
                if (!currentQ) { console.log('[Playlist] La cola desapareció, abortando.'); return; }

                currentQ.songs.push(song);
                added++;

                // Pre-descargar la siguiente canción si la cola estaba vacía
                if (currentQ.songs.length === 2) {
                    preDownloadNext(guildId);
                }
            } catch { }
        }

        if (added > 0) {
            const currentQ = queue.get(guildId);
            if (currentQ) {
                currentQ.textChannel.send({
                    embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`📋 **${added}** canciones más cargadas de la playlist.`)]
                }).catch(() => { });
            }
        }
        console.log(`[Playlist] Cargadas ${added} canciones en segundo plano.`);
    } catch (e) {
        console.error(`[Playlist] Falló la carga en segundo plano: ${e.message}`);
    }
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'N/D';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ─── Descargar canción a archivo temporal ─────────────────────────
function downloadSong(url, guildId) {
    return new Promise((resolve, reject) => {
        const outputPath = makeTempPath(guildId);

        const args = [
            ...ytdlpBaseArgs(),
            '-f', 'ba[abr<=96][ext=webm]/ba[abr<=96]/ba[ext=webm]/ba/b',
            '-x',
            '--audio-format', 'opus',
            '--audio-quality', '6',
            '--no-part',
            '-o', outputPath,
            url
        ];

        console.log(`[Descarga] Iniciando: ${url}`);
        const start = Date.now();

        const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });

        const timeout = setTimeout(() => {
            try { proc.kill(); } catch { }
            safeDelete(outputPath);
            reject(new Error('La descarga superó el tiempo límite (90s)'));
        }, 90000);

        proc.on('close', (code) => {
            clearTimeout(timeout);
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);

            if (code !== 0) {
                console.error(`[Descarga] Falló (${elapsed}s, código ${code}): ${stderr.slice(-300)}`);
                safeDelete(outputPath);
                return reject(new Error(`Falló la descarga: ${stderr.slice(-200)}`));
            }

            const dir = path.dirname(outputPath);
            const base = path.basename(outputPath, path.extname(outputPath));
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));

            if (files.length === 0) {
                return reject(new Error('La descarga no produjo ningún archivo'));
            }

            const actualPath = path.join(dir, files[0]);
            console.log(`[Descarga] Lista (${elapsed}s): ${actualPath}`);
            resolve(actualPath);
        });
    });
}

// ─── Enrutador de comandos (prefijo) ──────────────────────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const serverQueue = queue.get(message.guild.id);
    const args = message.content.split(' ');
    const command = args[0].toLowerCase();

    const ctx = {
        guild: message.guild,
        member: message.member,
        channel: message.channel,
        reply: (opts) => message.reply(opts),
        send: (opts) => message.channel.send(opts),
        isSlash: false,
    };

    try {
        if (command === '!play') {
            const query = message.content.split(' ').slice(1).join(' ');
            await execute(ctx, serverQueue, query);
        } else if (command === '!skip') {
            handleSkip(ctx, serverQueue);
        } else if (command === '!stop') {
            handleStop(ctx, serverQueue);
        } else if (command === '!queue') {
            showQueue(ctx, serverQueue);
        } else if (command === '!np' || command === '!nowplaying') {
            showNowPlaying(ctx, serverQueue);
        } else if (command === '!ping') {
            ctx.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(THEME.info)
                        .setDescription(`Latencia: **${client.ws.ping}ms**`)
                ]
            });
        } else if (command === '!help') {
            showHelp(ctx);
        } else if (command === '!premium') {
            await handlePremium(ctx, args[1]);
        } else if (command === '!loop') {
            await handleLoop(ctx, serverQueue);
        } else if (command === '!volume') {
            await handleVolume(ctx, serverQueue, parseInt(args[1]));
        } else if (command === '!speed') {
            await handleSpeed(ctx, serverQueue, parseDecimal(args[1]));
        } else if (command === '!pitch') {
            await handlePitch(ctx, serverQueue, parseDecimal(args[1]));
        } else if (command === '!set' || command === '!jump') {
            await handleSet(ctx, serverQueue, args.slice(1).join(' '));
        } else if (command === '!tts') {
            await handleTts(ctx, serverQueue, args.slice(1).join(' '));
        }
    } catch (err) {
        console.error(`[Error de comando] ${command}:`, err.message);
    }
});

// ─── Enrutador de comandos (slash) ────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (MOD_COMMANDS.has(interaction.commandName)) return; // gestionado por el módulo de moderación

    const serverQueue = queue.get(interaction.guild.id);

    // Diferir TODOS los comandos slash
    await interaction.deferReply();

    const ctx = {
        guild: interaction.guild,
        member: interaction.member,
        channel: interaction.channel,
        reply: (opts) => interaction.editReply(opts),
        send: (opts) => interaction.channel.send(opts),
        deleteReply: () => interaction.deleteReply().catch(() => { }),
        isSlash: true,
    };

    try {
        switch (interaction.commandName) {
            case 'play': {
                const query = interaction.options.getString('query');
                const sq = queue.get(interaction.guild.id);
                if (sq) {
                    sq._actionMutex = (sq._actionMutex || Promise.resolve()).then(() => execute(ctx, sq, query));
                } else {
                    await execute(ctx, null, query);
                }
                break;
            }
            case 'skip':
                if (serverQueue) serverQueue._actionMutex = (serverQueue._actionMutex || Promise.resolve()).then(() => handleSkip(ctx, serverQueue));
                break;
            case 'stop':
                if (serverQueue) serverQueue._actionMutex = (serverQueue._actionMutex || Promise.resolve()).then(() => handleStop(ctx, serverQueue));
                break;
            case 'forward':
                if (serverQueue) {
                    serverQueue._actionMutex = (serverQueue._actionMutex || Promise.resolve()).then(() => {
                        let posFwd = getCurrentPosition(serverQueue) + 10;
                        const durFwd = serverQueue.songs[0]?.durationSecs || parseTimeStr(serverQueue.songs[0]?.duration) || Infinity;
                        if (durFwd > 0 && posFwd >= durFwd) {
                            handleSkip(ctx, serverQueue);
                        } else {
                            serverQueue.seekTo = posFwd;
                            playSong(interaction.guild.id);
                            ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription('⏩ Avanzado 10 segundos.')] }).catch(() => { });
                        }
                    });
                } else {
                    ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] }).catch(() => { });
                }
                break;
            case 'rewind':
                if (serverQueue) {
                    serverQueue._actionMutex = (serverQueue._actionMutex || Promise.resolve()).then(() => {
                        serverQueue.seekTo = Math.max(0, getCurrentPosition(serverQueue) - 10);
                        playSong(interaction.guild.id);
                        ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription('⏪ Retrocedido 10 segundos.')] }).catch(() => { });
                    });
                } else {
                    ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] }).catch(() => { });
                }
                break;
            case 'queue':
                showQueue(ctx, serverQueue);
                break;
            case 'np':
                showNowPlaying(ctx, serverQueue);
                break;
            case 'help':
                showHelp(ctx);
                break;
            case 'ping':
                ctx.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(THEME.info)
                            .setDescription(`Latencia: **${client.ws.ping}ms**`)
                    ]
                });
                break;
            case 'premium':
                await handlePremium(ctx, interaction.options.getUser('user')?.id);
                break;
            case 'loop':
                await handleLoop(ctx, serverQueue);
                break;
            case 'volume':
                await handleVolume(ctx, serverQueue, interaction.options.getInteger('level'));
                break;
            case 'speed':
                await handleSpeed(ctx, serverQueue, parseDecimal(interaction.options.getString('rate')));
                break;
            case 'pitch':
                await handlePitch(ctx, serverQueue, parseDecimal(interaction.options.getString('level')));
                break;
            case 'set':
            case 'jump':
                await handleSet(ctx, serverQueue, interaction.options.getString('time'));
                break;
            case 'tts':
                await handleTts(ctx, serverQueue, interaction.options.getString('text'));
                break;
        }
    } catch (err) {
        console.error(`[Error slash] /${interaction.commandName}:`, err.message);
        ctx.reply({ embeds: [errEmbed(`Algo salió mal: ${err.message}`)] }).catch(() => { });
    }
});

// ─── Manejador de botones ─────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('m_')) return;

    const guildId = interaction.guild.id;
    const sq = queue.get(guildId);
    const vc = interaction.member.voice?.channel;

    if (!sq || !vc || vc.id !== sq.voiceChannel.id) {
        return interaction.reply({ content: 'Debes estar en el mismo canal de voz que el bot.', ephemeral: true });
    }

    try {
        if (interaction.customId === 'm_pause') {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply({ ephemeral: true });
        }

        switch (interaction.customId) {
            case 'm_prev': {
                if (!sq.previousSong) {
                    return interaction.editReply({ content: 'No hay canción anterior.' });
                }
                const oldMsg = sq.nowPlayingMsg;
                if (oldMsg) { oldMsg.edit({ components: [] }).catch(() => { }); sq.nowPlayingMsg = null; }

                sq.songs.unshift(sq.previousSong);
                sq.previousSong = null;
                sq._skipNextIdle = true;
                playSong(guildId);
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription('⏮️ Reproduciendo la canción anterior.')] });
                break;
            }
            case 'm_back10': {
                const pos = Math.max(0, getCurrentPosition(sq) - 10);
                sq.seekTo = pos;
                playSong(guildId);
                const mb = Math.floor(pos / 60), sb = Math.floor(pos % 60);
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`⏪ Atrás a **${mb}:${sb.toString().padStart(2, '0')}**`)] });
                break;
            }
            case 'm_pause': {
                if (sq.player.state.status === AudioPlayerStatus.Paused) {
                    sq.player.unpause();
                    if (sq.playStartOffset != null) {
                        sq.playStartTime = Date.now();
                    }

                    const comps = interaction.message.components[0].components.map(c => {
                        if (c.customId === 'm_pause') return new ButtonBuilder().setCustomId('m_pause').setEmoji('⏸️').setStyle(ButtonStyle.Danger);
                        return ButtonBuilder.from(c);
                    });
                    const row = new ActionRowBuilder().addComponents(comps);
                    await interaction.editReply({ components: [row] });
                    await interaction.followUp({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription('▶️ Reanudado.')], ephemeral: true });
                } else {
                    sq.playStartOffset = getCurrentPosition(sq);
                    sq.playStartTime = null;
                    sq.player.pause();

                    const comps = interaction.message.components[0].components.map(c => {
                        if (c.customId === 'm_pause') return new ButtonBuilder().setCustomId('m_pause').setEmoji('▶️').setStyle(ButtonStyle.Success);
                        return ButtonBuilder.from(c);
                    });
                    const row = new ActionRowBuilder().addComponents(comps);
                    await interaction.editReply({ components: [row] });
                    await interaction.followUp({ embeds: [new EmbedBuilder().setColor(THEME.warning).setDescription('⏸️ Pausado.')], ephemeral: true });
                }
                break;
            }
            case 'm_fwd10': {
                const durSecs = sq.songs[0]?.durationSecs || parseTimeStr(sq.songs[0]?.duration) || Infinity;

                let pos = getCurrentPosition(sq) + 10;
                if (pos >= durSecs && durSecs > 0) {
                    pos = Math.max(0, durSecs - 2); // Limitar cerca del final
                }

                sq.seekTo = pos;
                playSong(guildId);
                const m = Math.floor(pos / 60), s = Math.floor(pos % 60);
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`⏩ Adelante a **${m}:${s.toString().padStart(2, '0')}**`)] });
                break;
            }
            case 'm_skip': {
                if (sq.songs.length === 0) {
                    return interaction.editReply({ content: 'Nada que saltar.' });
                }
                const oldMsg = sq.nowPlayingMsg;
                if (oldMsg) { oldMsg.edit({ components: [] }).catch(() => { }); sq.nowPlayingMsg = null; }

                const skipped = sq.songs[0];
                sq.loop = false;
                sq.player.stop(true);
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(THEME.warning).setDescription(`⏭️ Saltada **${fmt(skipped?.title, 40)}**`)] });
                break;
            }
        }
    } catch (e) {
        console.error('[Error de botón]:', e.message);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: 'Algo salió mal.', ephemeral: true }).catch(() => { });
        } else {
            interaction.followUp({ content: 'Algo salió mal.', ephemeral: true }).catch(() => { });
        }
    }
});

// ─── Cambio de estado de voz (detección de expulsión/desconexión) ─
client.on('voiceStateUpdate', (oldState, newState) => {
    // Solo importa el propio bot
    if (oldState.member?.id !== client.user.id) return;

    // El bot estaba en un canal de voz y ahora NO lo está (expulsado/desconectado)
    if (oldState.channelId && !newState.channelId) {
        const guildId = oldState.guild.id;
        const sq = queue.get(guildId);
        if (!sq) return;

        console.log(`[VC] Bot retirado de ${oldState.channel?.name || 'canal de voz'} en ${oldState.guild.name}`);

        // Limpiar archivos temporales
        for (const s of sq.songs) {
            if (s.filePath) safeDelete(s.filePath);
        }

        // Limpiar timeout de salida
        if (sq.leaveTimeout) clearTimeout(sq.leaveTimeout);

        // Eliminar la cola ANTES de detener el reproductor: player.stop() emite
        // 'Idle' de forma SÍNCRONA, y si la cola todavía existe el manejador Idle
        // reproduciría la siguiente canción (mensajes fantasma tras la desconexión).
        queue.delete(guildId);

        // Matar proceso ffmpeg si existe
        if (sq.ffmpegProc) { try { sq.ffmpegProc.kill(); } catch { } sq.ffmpegProc = null; }

        // Detener reproductor
        try { sq.player.stop(true); } catch { }

        // Destruir conexión si sigue viva
        try { sq.connection?.destroy(); } catch { }

        // Enviar notificación
        sq.textChannel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(THEME.danger)
                    .setDescription('Desconectado del canal de voz — la cola se ha vaciado.')
            ]
        }).catch(() => { });
    }
});

// ─── Comando Play ─────────────────────────────────────────────────
async function execute(ctx, serverQueue, query) {
    const vc = ctx.member.voice?.channel;
    if (!query) return ctx.reply({ embeds: [errEmbed('Proporciona el nombre de una canción o una URL.')] });

    // Mostrar indicador de carga
    const loadEmbed = new EmbedBuilder()
        .setColor(THEME.info)
        .setDescription(`Cargando **${fmt(query, 50)}**...`);

    let loadMsg;
    if (ctx.isSlash) {
        // En slash, la respuesta diferida se convierte en el mensaje de carga
        await ctx.reply({ embeds: [loadEmbed] });
    } else {
        loadMsg = await ctx.send({ embeds: [loadEmbed] });
    }

    // Búsqueda
    console.log(`[Búsqueda] Consulta: "${query}"`);
    const songs = await searchSong(query);

    if (!songs || songs.length === 0) {
        const failEmbed = new EmbedBuilder()
            .setColor(THEME.danger)
            .setDescription(`No se encontraron resultados para **${fmt(query, 50)}**`);
        if (ctx.isSlash) {
            return ctx.reply({ embeds: [failEmbed] });
        } else {
            if (loadMsg) loadMsg.edit({ embeds: [failEmbed] }).catch(() => { });
            return { error: 'No se encontraron resultados.' };
        }
    }

    if (!vc) {
        if (!serverQueue) {
            const guildId = ctx.guild.id;
            const qc = {
                textChannel: ctx.channel,
                voiceChannel: null,
                connection: null,
                songs: [...songs],
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                leaveTimeout: null,
                loop: false,
                volume: 50,
                speed: 1.0,
                pitch: 1.0,
                seekTo: null,
                ttsFile: null,
                ffmpegProc: null,
                playStartTime: null,
                playStartOffset: 0,
                previousSong: null,
                nowPlayingMsg: null,
            };
            queue.set(guildId, qc);
        } else {
            serverQueue.songs.push(...songs);
        }

        const embed = new EmbedBuilder()
            .setColor(THEME.warning)
            .setAuthor({ name: 'AÑADIDA A LA COLA' })
            .setTitle(songs[0].title)
            .setDescription('**Nota:** El bot no se unió a ningún canal de voz porque no estás conectado a uno. Únete a un canal para empezar la reproducción.')
            .setURL(songs[0].url);

        if (ctx.isSlash) {
            ctx.reply({ embeds: [embed] });
        } else {
            ctx.send({ embeds: [embed] });
        }
        return { warning: 'NOT_IN_VC' };
    }

    // En comandos de prefijo, borrar el mensaje de carga ahora
    if (!ctx.isSlash && loadMsg) {
        loadMsg.delete().catch(() => { });
    }

    if (!serverQueue) {
        const guildId = ctx.guild.id;
        const playlistUrl = songs[0]?._playlistUrl;
        const qc = {
            textChannel: ctx.channel,
            voiceChannel: vc,
            connection: null,
            songs: [...songs],
            player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
            leaveTimeout: null,
            loop: false,
            volume: 50,
            speed: 1.0,
            pitch: 1.0,
            seekTo: null,
            ttsFile: null,
            ffmpegProc: null,
            playStartTime: null,
            playStartOffset: 0,
            previousSong: null,
            nowPlayingMsg: null,
        };

        queue.set(guildId, qc);

        try {
            const sodium = require('libsodium-wrappers');
            await sodium.ready;

            function applyVpsFix(connection) {
                // Solo manejar desconexiones DESPUÉS de que la conexión esté establecida
                // para evitar destruirla durante el handshake UDP inicial
                let fullyConnected = false;

                connection.on('stateChange', (oldS, newS) => {
                    console.log(`[Conn] ${oldS.status} → ${newS.status}`);

                    // Limpiar keepAlive UDP (arreglo VPS para bucles de paquetes)
                    const newNetworking = Reflect.get(newS, 'networking');
                    if (newNetworking) {
                        newNetworking.on('stateChange', (oldNS, newNS) => {
                            const newUdp = Reflect.get(newNS, 'udp');
                            clearInterval(newUdp?.keepAliveInterval);
                        });
                    }

                    if (newS.status === VoiceConnectionStatus.Ready) {
                        fullyConnected = true;
                    }

                    if (newS.status === VoiceConnectionStatus.Disconnected && fullyConnected) {
                        try {
                            entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                                .catch(() => {
                                    const q = queue.get(guildId);
                                    if (q) {
                                        for (const s of q.songs) { if (s.filePath) safeDelete(s.filePath); }
                                        if (q.leaveTimeout) clearTimeout(q.leaveTimeout);
                                        q.textChannel.send({
                                            embeds: [new EmbedBuilder().setColor(THEME.danger).setDescription('Desconectado del canal de voz — cola vaciada.')]
                                        }).catch(() => { });
                                    }
                                    connection.destroy();
                                    queue.delete(guildId);
                                });
                        } catch {
                            const q = queue.get(guildId);
                            if (q) {
                                for (const s of q.songs) { if (s.filePath) safeDelete(s.filePath); }
                                if (q.leaveTimeout) clearTimeout(q.leaveTimeout);
                            }
                            connection.destroy();
                            queue.delete(guildId);
                        }
                    } else if (newS.status === VoiceConnectionStatus.Destroyed) {
                        const q = queue.get(guildId);
                        if (q) {
                            for (const s of q.songs) { if (s.filePath) safeDelete(s.filePath); }
                            if (q.leaveTimeout) clearTimeout(q.leaveTimeout);
                        }
                        queue.delete(guildId);
                    }
                });
            }

            console.log('[Estado] Esperando handshake de voz...');
            let connected = false;
            let conn = null;
            const timeouts = [45000, 45000, 30000];

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    if (conn) {
                        try { conn.destroy(); } catch { }
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    console.log(`[Estado] Intento de handshake ${attempt}/3 (timeout: ${timeouts[attempt - 1] / 1000}s)...`);

                    conn = joinVoiceChannel({
                        channelId: vc.id,
                        guildId: guildId,
                        adapterCreator: ctx.guild.voiceAdapterCreator,
                    });

                    applyVpsFix(conn);

                    await entersState(conn, VoiceConnectionStatus.Ready, timeouts[attempt - 1]);
                    console.log('[Estado] ¡Handshake OK!');
                    connected = true;
                    break;
                } catch (e) {
                    console.error(`[Estado] Intento ${attempt} falló: ${e.message}`);
                }
            }

            if (!connected) {
                console.error('[Estado] Todos los intentos de handshake fallaron.');
                if (conn) try { conn.destroy(); } catch { }
                queue.delete(guildId);
                return ctx.send({ embeds: [errEmbed('Falló la conexión de voz tras 3 intentos. Inténtalo de nuevo.')] });
            }

            qc.connection = conn;
            conn.subscribe(qc.player);

            qc.player.on('stateChange', (oldS, newS) => {
                console.log(`[Reproductor] ${oldS.status} → ${newS.status}`);
                if (newS.status === AudioPlayerStatus.Playing) {
                    const q = queue.get(guildId);
                    if (q) {
                        q.playStartTime = Date.now();
                        q._restarting = false;
                    }
                }
            });

            qc.player.on(AudioPlayerStatus.Idle, () => {
                const q = queue.get(guildId);
                if (!q) return;

                // Guarda: si playSong está reiniciando (seek/pitch/speed), ignorar este Idle
                if (q._restarting) return;

                // Matar proceso ffmpeg si existe
                if (q.ffmpegProc) { try { q.ffmpegProc.kill(); } catch { } q.ffmpegProc = null; }

                // Destruir el recurso de audio antiguo para matar el ffmpeg de prism-media
                try {
                    const oldResource = q.player.state.resource;
                    if (oldResource) { oldResource.playStream?.destroy(); oldResource.encoder?.destroy(); }
                } catch { }

                // TTS terminó — limpiar temporal y reanudar música
                if (q.ttsFile) {
                    safeDelete(q.ttsFile);
                    const resumePos = q.ttsResumeOffset != null ? q.ttsResumeOffset : 0;
                    q.ttsFile = null;
                    q.ttsResumeOffset = null;
                    if (q.songs.length > 0) {
                        // Reanudar música desde donde estaba antes del TTS
                        q.seekTo = resumePos;
                        playSong(guildId);
                    }
                    return;
                }

                // Bucle — repetir la misma canción
                if (q.loop && q.songs.length > 0) {
                    q.seekTo = null;
                    playSong(guildId);
                    return;
                }

                // Guardar canción anterior para el botón de atrás
                const finished = q.songs[0];
                if (finished) {
                    q.previousSong = { title: finished.title, url: finished.url, duration: finished.duration, channel: finished.channel, source: finished.source, thumbnail: finished.thumbnail };
                }
                if (finished?.filePath) safeDelete(finished.filePath);

                q.songs.shift();
                if (q.songs.length > 0) {
                    playSong(guildId);
                } else {
                    q.leaveTimeout = setTimeout(() => {
                        const stillQ = queue.get(guildId);
                        if (stillQ && stillQ.songs.length === 0) {
                            stillQ.connection?.destroy();
                            queue.delete(guildId);
                            stillQ.textChannel.send({
                                embeds: [
                                    new EmbedBuilder()
                                        .setColor(THEME.muted)
                                        .setDescription('Cola terminada — saliendo del canal.')
                                ]
                            }).catch(() => { });
                        }
                    }, 120000);
                }
            });

            qc.player.on('error', err => {
                console.error('[Error de audio]:', err.message);
                const q = queue.get(guildId);
                if (q) {
                    if (q.songs[0]?.filePath) safeDelete(q.songs[0].filePath);
                    q.textChannel.send({ embeds: [errEmbed('Error de reproducción — saltando canción.')] }).catch(() => { });
                    q.songs.shift();
                    if (q.songs.length > 0) playSong(guildId);
                }
            });

            // Borrar la respuesta 'Cargando...' del slash antes de reproducir
            if (ctx.isSlash && ctx.deleteReply) ctx.deleteReply();

            playSong(guildId);

            // Si era una playlist, cargar el resto en segundo plano
            if (playlistUrl) {
                loadPlaylistBackground(guildId, playlistUrl, songs[0].url);
            }

        } catch (err) {
            queue.delete(ctx.guild.id);
            return ctx.send({ embeds: [errEmbed(`Falló al unirse: ${err.message}`)] });
        }
    } else {
        if (serverQueue.leaveTimeout) {
            clearTimeout(serverQueue.leaveTimeout);
            serverQueue.leaveTimeout = null;
        }

        const playlistUrl = songs[0]?._playlistUrl;
        serverQueue.songs.push(...songs);

        // ARREGLO: si el reproductor está inactivo, empezar reproducción de inmediato
        if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
            if (ctx.isSlash && ctx.deleteReply) ctx.deleteReply();
            playSong(ctx.guild.id);
            return;
        }

        const isPlaylist = songs.length > 1;
        const firstSong = songs[0];

        const embed = new EmbedBuilder()
            .setColor(THEME.accent)
            .setAuthor({
                name: isPlaylist ? 'PLAYLIST AÑADIDA' : 'AÑADIDA A LA COLA',
                iconURL: firstSong.source === 'YouTube'
                    ? 'https://cdn-icons-png.flaticon.com/512/1384/1384060.png'
                    : 'https://cdn-icons-png.flaticon.com/512/145/145810.png'
            })
            .setTitle(isPlaylist ? `${songs.length} canciones añadidas` : firstSong.title)
            .setURL(firstSong.url)
            .addFields(
                { name: isPlaylist ? 'Primera duración' : 'Duración', value: `\`${firstSong.duration || 'N/D'}\``, inline: true },
                { name: 'Posición', value: `\`#${serverQueue.songs.length - songs.length + 1}\``, inline: true },
                { name: 'Fuente', value: `\`${firstSong.source}\``, inline: true }
            )
            .setFooter({ text: 'Ethernal' })
            .setTimestamp();
        if (!isPlaylist && firstSong.thumbnail) embed.setThumbnail(firstSong.thumbnail);

        // En slash, la respuesta diferida se convierte en el embed 'Añadida a la cola'
        // En prefijo, simplemente enviar al canal
        if (ctx.isSlash) {
            ctx.reply({ embeds: [embed] });
        } else {
            ctx.send({ embeds: [embed] });
        }

        // Pre-descargar si es la siguiente canción
        if (serverQueue.songs.length === 2) {
            preDownloadNext(ctx.guild.id);
        }

        // Si era una playlist, cargar el resto en segundo plano
        if (playlistUrl) {
            loadPlaylistBackground(ctx.guild.id, playlistUrl, songs[0].url);
        }
    }
}


// ─── Pre-descargar siguiente canción ──────────────────────────────
async function preDownloadNext(guildId) {
    const sq = queue.get(guildId);
    if (!sq || sq.songs.length < 2) return;

    const nextSong = sq.songs[1];
    if (nextSong.filePath) return;

    try {
        console.log(`[PreDescarga] Iniciando: "${nextSong.title}"`);
        nextSong.filePath = await downloadSong(nextSong.url, guildId);
        console.log(`[PreDescarga] Lista: "${nextSong.title}" → ${nextSong.filePath}`);
    } catch (e) {
        console.error(`[PreDescarga] Falló para "${nextSong.title}": ${e.message}`);
    }
}

// ─── Reproducir canción ───────────────────────────────────────────
async function playSong(guildId) {
    const sq = queue.get(guildId);
    if (!sq || sq.songs.length === 0) return;

    // Guarda: evitar que el manejador Idle desplace la cola durante el reinicio
    sq._restarting = true;

    const song = sq.songs[0];
    console.log(`[Play] "${song.title}" → ${song.url}`);

    try {
        if (!song.url || !song.url.startsWith('http')) {
            throw new Error(`URL inválida: ${song.url}`);
        }

        // Descargar si no está pre-descargada O si el archivo ya fue borrado
        let loadMsg = null;
        if (!song.filePath || !fs.existsSync(song.filePath)) {
            song.filePath = null; // Resetear ruta obsoleta antes de re-descargar
            loadMsg = await sq.textChannel?.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(THEME.info)
                        .setDescription(`Cargando **${fmt(song.title, 50)}**...`)
                ]
            }).catch(() => null);

            song.filePath = await downloadSong(song.url, guildId);
        }

        // Si la cola se destruyó (p.ej. desconexión) mientras descargábamos,
        // abortar en silencio: no reproducir ni enviar mensajes fantasma.
        if (queue.get(guildId) !== sq) {
            if (loadMsg) loadMsg.delete().catch(() => { });
            if (song.filePath) safeDelete(song.filePath);
            return;
        }

        // Matar proceso ffmpeg anterior si existe
        if (sq.ffmpegProc) { try { sq.ffmpegProc.kill(); } catch { } sq.ffmpegProc = null; }

        // Destruir recurso de audio antiguo para matar el ffmpeg interno de prism-media (evita zombies)
        try {
            const oldResource = sq.player.state.resource;
            if (oldResource) { oldResource.playStream?.destroy(); oldResource.encoder?.destroy(); }
        } catch { }

        // Construir recurso de audio — pipeline de filtros ffmpeg si cambió speed/pitch/seek
        const startOffset = sq.seekTo || 0;
        const needsProcessing = sq.speed !== 1.0 || sq.pitch !== 1.0 || sq.seekTo;
        let resource;

        if (needsProcessing) {
            const ffArgs = [];
            if (sq.seekTo) {
                ffArgs.push('-ss', String(sq.seekTo));
                sq.seekTo = null;
            }
            ffArgs.push('-i', song.filePath);
            const filters = [];
            if (sq.speed !== 1.0) {
                let s = sq.speed;
                while (s < 0.5) { filters.push('atempo=0.5'); s /= 0.5; }
                while (s > 2.0) { filters.push('atempo=2.0'); s /= 2.0; }
                filters.push(`atempo=${s.toFixed(4)}`);
            }
            if (sq.pitch !== 1.0) {
                filters.push(`asetrate=${Math.round(48000 * sq.pitch)}`, 'aresample=48000');
            }
            if (filters.length > 0) ffArgs.push('-af', filters.join(','));
            ffArgs.push('-f', 'opus', '-c:a', 'libopus', '-b:a', '192k', '-ar', '48000', '-ac', '2', 'pipe:1');
            const proc = spawn(ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            sq.ffmpegProc = proc;
            resource = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });

            let ffErr = '';
            proc.stderr.on('data', chunk => { ffErr += chunk.toString(); });
            proc.on('close', code => {
                if (code !== 0 && code !== 255) console.error(`[FFmpeg] salida ${code}:`, ffErr.substring(ffErr.length - 500));
            });
            proc.on('error', () => { });
        } else {
            resource = createAudioResource(fs.createReadStream(song.filePath), { inputType: StreamType.Arbitrary, inlineVolume: true });
        }

        resource.volume?.setVolume(sq.volume / 50);
        sq.player.play(resource);
        sq.playStartOffset = startOffset;

        // Borrar el mensaje de carga ahora que está sonando
        if (loadMsg) loadMsg.delete().catch(() => { });

        // ─── Embed de "Sonando ahora" con botones ────────────────
        const bar = makeProgressBar();
        const embed = new EmbedBuilder()
            .setColor(THEME.primary)
            .setAuthor({
                name: 'SONANDO AHORA',
                iconURL: ICONS[song.source] || null
            })
            .setTitle(song.title)
            .setURL(song.url)
            .setDescription([
                '',
                `▶ ${bar}`,
                `**Duración** · \`${song.duration || 'EN VIVO'}\``,
                `**Canal** · \`${fmt(song.channel, 30)}\``,
                `**Fuente** · \`${song.source || 'Desconocida'}\``,
                `**A continuación** · ${sq.songs.length > 1 ? fmt(sq.songs[1].title, 40) : 'Nada'}`,
            ].join('\n'))
            .setFooter({ text: `Sonando en ${sq.voiceChannel?.name || 'Canal desconocido'} · Ethernal\n\n💡 Guía: ⏮️ Anterior | ⏪ -10s | ⏸️ Pausa | ⏩ +10s | ⏭️ Saltar` })
            .setTimestamp();

        if (song.thumbnail) embed.setImage(song.thumbnail);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('m_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('m_back10').setEmoji('⏪').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('m_pause').setEmoji(sq.player.state.status === AudioPlayerStatus.Paused ? '▶️' : '⏸️').setStyle(sq.player.state.status === AudioPlayerStatus.Paused ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('m_fwd10').setEmoji('⏩').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('m_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
        );

        // Si es la misma canción (bucle, seek, cambio de tono) y ya hay mensaje, editarlo
        const isSameSong = sq.lastSongUrl === song.url;
        sq.lastSongUrl = song.url;

        if (isSameSong && sq.nowPlayingMsg) {
            sq.nowPlayingMsg.edit({ embeds: [embed], components: [row] }).catch(() => { });
        } else {
            // Borrar el mensaje antiguo de "Sonando ahora" para no inundar el chat
            if (sq.nowPlayingMsg) { sq.nowPlayingMsg.delete().catch(() => { }); sq.nowPlayingMsg = null; }
            sq.nowPlayingMsg = await sq.textChannel?.send({ embeds: [embed], components: [row] }).catch(() => null);
        }

        // Pre-descargar la siguiente canción
        if (sq.songs.length >= 2) {
            preDownloadNext(guildId);
        }

    } catch (e) {
        sq._restarting = false;
        console.warn(`[Error de Play] ${song.title}: ${e.message}`);
        if (song.filePath) safeDelete(song.filePath);
        // No avisar ni continuar si la cola ya no existe (desconexión durante la descarga)
        if (queue.get(guildId) !== sq) return;
        sq.textChannel?.send({ embeds: [errEmbed(`Falló al reproducir **${fmt(song.title)}**`)] }).catch(() => { });
        sq.songs.shift();
        if (sq.songs.length > 0) playSong(guildId);
    }
}

// ─── Saltar ───────────────────────────────────────────────────────
function handleSkip(ctx, sq) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('Nada que saltar.')] });

    const skipped = sq.songs[0];
    const hasNext = sq.songs.length > 1;
    const nextTitle = hasNext ? sq.songs[1].title : null;

    sq.loop = false; // Desactivar bucle para permitir el salto
    sq.player.stop(true);
    // El manejador Idle desplazará la canción y reproducirá la siguiente

    const desc = hasNext
        ? `Saltada **${fmt(skipped.title)}**\nA continuación: **${fmt(nextTitle)}**`
        : `Saltada **${fmt(skipped.title)}**\nLa cola está ahora vacía.`;

    ctx.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(THEME.warning)
                .setDescription(desc)
        ]
    });
}

// ─── Detener ──────────────────────────────────────────────────────
function handleStop(ctx, sq) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!sq) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });

    const count = sq.songs.length;

    for (const s of sq.songs) {
        if (s.filePath) safeDelete(s.filePath);
    }

    if (sq.nowPlayingMsg) {
        sq.nowPlayingMsg.delete().catch(() => {});
        sq.nowPlayingMsg = null;
    }

    sq.songs = [];
    sq.player.stop(true);
    if (sq.leaveTimeout) clearTimeout(sq.leaveTimeout);
    sq.connection?.destroy();
    queue.delete(ctx.guild.id);

    ctx.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(THEME.danger)
                .setDescription(`Reproducción detenida y ${count} canción${count !== 1 ? 'es' : ''} eliminada${count !== 1 ? 's' : ''}.`)
        ]
    });
}

// ─── Cola ─────────────────────────────────────────────────────────
function showQueue(ctx, sq) {
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('La cola está vacía.')] });

    const current = sq.songs[0];
    const upcoming = sq.songs.slice(1, 10);

    let desc = `**Sonando ahora**\n[${fmt(current.title, 50)}](${current.url}) · \`${current.duration || 'EN VIVO'}\`\n`;

    if (upcoming.length > 0) {
        desc += `\n**A continuación**\n`;
        desc += upcoming.map((s, i) =>
            `\`${i + 1}.\` [${fmt(s.title, 40)}](${s.url}) · \`${s.duration || 'N/D'}\``
        ).join('\n');
    }

    if (sq.songs.length > 10) {
        desc += `\n\n*+${sq.songs.length - 10} más*`;
    }

    const embed = new EmbedBuilder()
        .setColor(THEME.primary)
        .setTitle(`Cola — ${sq.songs.length} canción${sq.songs.length > 1 ? 'es' : ''}`)
        .setDescription(desc)
        .setFooter({ text: sq.voiceChannel.name })
        .setTimestamp();
    if (current.thumbnail) embed.setThumbnail(current.thumbnail);

    ctx.reply({ embeds: [embed] });
}

// ─── Sonando ahora ────────────────────────────────────────────────
function showNowPlaying(ctx, sq) {
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando ahora mismo.')] });

    const song = sq.songs[0];
    const bar = makeProgressBar(20);

    const embed = new EmbedBuilder()
        .setColor(THEME.primary)
        .setAuthor({
            name: 'SONANDO AHORA',
            iconURL: ICONS[song.source] || null
        })
        .setTitle(song.title)
        .setURL(song.url)
        .setDescription([
            '',
            `▶ ${bar}`,
            '',
            `**Duración** · \`${song.duration || 'EN VIVO'}\``,
            `**Canal** · \`${fmt(song.channel, 30)}\``,
            `**Fuente** · \`${song.source || 'Desconocida'}\``,
            `**A continuación** · ${sq.songs.length > 1 ? fmt(sq.songs[1].title, 40) : 'Nada'}`,
        ].join('\n'))
        .setFooter({ text: `Sonando en ${sq.voiceChannel.name}` })
        .setTimestamp();
    if (song.thumbnail) embed.setImage(song.thumbnail);

    ctx.reply({ embeds: [embed] });
}

// ─── Ayuda ────────────────────────────────────────────────────────
function showHelp(ctx) {
    const embed = new EmbedBuilder()
        .setColor(THEME.primary)
        .setTitle('Ethernal')
        .setDescription('Tu compañero de música para el clan.')
        .addFields(
            {
                name: 'Reproducción', value: [
                    '`/play` `!play` — Reproduce o encola una canción',
                    '`/skip` `!skip` — Salta la canción actual',
                    '`/stop` `!stop` — Detiene y limpia la cola',
                ].join('\n')
            },
            {
                name: 'Información', value: [
                    '`/queue` `!queue` — Ver la cola',
                    '`/np` `!np` — Sonando ahora',
                    '`/ping` `!ping` — Latencia',
                ].join('\n')
            },
            {
                name: '✨ Premium', value: [
                    '`/loop` — Activa/desactiva el bucle de la canción actual',
                    '`/volume <0-100>` — Ajusta el volumen',
                    '`/speed <0.25-3>` — Ajusta la velocidad',
                    '`/pitch <0.25-3>` — Ajusta el tono',
                    '`/set <tiempo>` — Salta a una posición (ej. 1m30s)',
                    '`/tts <texto>` — Texto a voz en el canal de voz',
                ].join('\n')
            },
            {
                name: 'Fuentes', value:
                    'Busca primero en YouTube, luego SoundCloud como respaldo.\nTambién funcionan las URLs directas de ambas plataformas.'
            }
        )
        .setFooter({ text: 'Ethernal', iconURL: ctx.guild.iconURL() })
        .setTimestamp();

    ctx.reply({ embeds: [embed] });
}

// ─── Comando Premium ──────────────────────────────────────────────
async function handlePremium(ctx, targetId) {
    if (ctx.member.id !== OWNER_ID) {
        return ctx.reply({ embeds: [errEmbed('Solo el dueño del bot puede gestionar el premium.')] });
    }
    if (!targetId) {
        return ctx.reply({ embeds: [errEmbed('Proporciona un usuario. Uso: `/premium @usuario`')] });
    }
    // Soportar formato @mención de los comandos de prefijo
    const cleanId = targetId.replace(/[<@!>]/g, '');
    let entry = await PremiumUser.findOne({ discordId: cleanId });
    if (entry) {
        entry.isPremium = !entry.isPremium;
        await entry.save();
    } else {
        entry = await PremiumUser.create({ discordId: cleanId, isPremium: true });
    }
    let userName = cleanId;
    try { const m = await ctx.guild.members.fetch(cleanId); userName = m.displayName; } catch { }
    ctx.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(entry.isPremium ? THEME.accent : THEME.warning)
                .setDescription(entry.isPremium
                    ? `✨ ¡**${userName}** ahora tiene estado **Premium**!`
                    : `Premium retirado a **${userName}**.`)
        ]
    });
}

// ─── Bucle ────────────────────────────────────────────────────────
async function handleLoop(ctx, sq) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!(await isPremium(ctx.member.id))) return ctx.reply({ embeds: [errEmbed('🔒 Función Premium.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });
    sq.loop = !sq.loop;
    ctx.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(sq.loop ? THEME.accent : THEME.warning)
                .setDescription(sq.loop ? '🔁 Bucle **activado** para la canción actual.' : '➡️ Bucle **desactivado**.')
        ]
    });
}

// ─── Volumen ──────────────────────────────────────────────────────
async function handleVolume(ctx, sq, level) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });
    if (level === undefined || level === null || isNaN(level)) {
        return ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.info).setDescription(`Volumen actual: **${sq.volume}**/100`)] });
    }
    level = Math.max(0, Math.min(100, level));
    if (level !== 50 && !(await isPremium(ctx.member.id))) {
        return ctx.reply({ embeds: [errEmbed('🔒 Premium requerido para cambiar el volumen. Sin premium queda fijo en 50.')] });
    }
    sq.volume = level;
    try { const r = sq.player.state.resource; if (r?.volume) r.volume.setVolume(level / 50); } catch { }
    ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`🔊 Volumen ajustado a **${level}**/100`)] });
}

// ─── Velocidad ────────────────────────────────────────────────────
async function handleSpeed(ctx, sq, rate) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!(await isPremium(ctx.member.id))) return ctx.reply({ embeds: [errEmbed('🔒 Función Premium.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });
    if (rate === undefined || rate === null || isNaN(rate)) {
        return ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.info).setDescription(`Velocidad actual: **${sq.speed}**x`)] });
    }
    rate = Math.max(0.25, Math.min(3.0, rate));
    const pos = getCurrentPosition(sq);
    sq.speed = rate;
    sq.seekTo = pos;
    playSong(ctx.guild.id);
    ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`⚡ Velocidad ajustada a **${rate}**x`)] });
}

// ─── Tono ─────────────────────────────────────────────────────────
async function handlePitch(ctx, sq, level) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!(await isPremium(ctx.member.id))) return ctx.reply({ embeds: [errEmbed('🔒 Función Premium.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });
    if (level === undefined || level === null || isNaN(level)) {
        return ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.info).setDescription(`Tono actual: **${sq.pitch}**x`)] });
    }
    level = Math.max(0.25, Math.min(3.0, level));
    const pos = getCurrentPosition(sq);
    sq.pitch = level;
    sq.seekTo = pos;
    playSong(ctx.guild.id);
    ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`🎵 Tono ajustado a **${level}**x`)] });
}

// ─── Set (Buscar posición) ────────────────────────────────────────
async function handleSet(ctx, sq, timeStr) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!(await isPremium(ctx.member.id))) return ctx.reply({ embeds: [errEmbed('🔒 Función Premium.')] });
    if (!sq || sq.songs.length === 0) return ctx.reply({ embeds: [errEmbed('No hay nada sonando.')] });
    const secs = parseTimeStr(timeStr);
    if (secs <= 0) return ctx.reply({ embeds: [errEmbed('Tiempo inválido. Usa: `1m30s`, `2:30`, o `90`')] });

    const durSecs = sq.songs[0]?.durationSecs || parseTimeStr(sq.songs[0]?.duration) || Infinity;
    if (secs >= durSecs && durSecs > 0) {
        return ctx.reply({ embeds: [errEmbed(`No puedes saltar más allá de la duración (\`${sq.songs[0]?.duration}\`).`)] });
    }

    sq.seekTo = secs;
    playSong(ctx.guild.id);
    const hrs = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60), s = secs % 60;
    const timeDisplay = hrs > 0 ? `${hrs}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
    ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`⏩ Saltando a **${timeDisplay}**`)] });
}

// ─── Jump ─────────────────────────────────────────────────────────
async function handleJump(ctx, sq, index) {
    if (!ctx.member.voice?.channel) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!sq || sq.songs.length < 2) return ctx.reply({ embeds: [errEmbed('No hay suficientes canciones en la cola.')] });
    const idx = parseInt(index);
    if (isNaN(idx) || idx < 1 || idx >= sq.songs.length) {
        return ctx.reply({ embeds: [errEmbed(`Introduce un índice válido (1 a ${sq.songs.length - 1}).`)] });
    }
    sq.songs.splice(1, idx - 1);
    playSong(ctx.guild.id);
    ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`⏭️ Saltado a la canción **#${idx}**. `)] });
}

// ─── TTS ──────────────────────────────────────────────────────────
async function handleTts(ctx, sq, text) {
    const vc = ctx.member.voice?.channel;
    if (!vc) return ctx.reply({ embeds: [errEmbed('Únete a un canal de voz primero.')] });
    if (!(await isPremium(ctx.member.id))) return ctx.reply({ embeds: [errEmbed('🔒 Función Premium.')] });
    if (!text || text.trim().length === 0) return ctx.reply({ embeds: [errEmbed('Proporciona el texto a decir.')] });
    const truncated = text.substring(0, 200);
    const ttsPath = path.join(TEMP_DIR, `tts_${crypto.randomBytes(4).toString('hex')}.mp3`);
    try {
        const encodedText = encodeURIComponent(truncated);
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=es&client=tw-ob&q=${encodedText}`;
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(ttsPath);
            https.get(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
                if (res.statusCode !== 200) return reject(new Error(`TTS HTTP ${res.statusCode}`));
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
        });

        const guildId = ctx.guild.id;
        if (!sq) {
            const sodium = require('libsodium-wrappers');
            await sodium.ready;
            const conn = joinVoiceChannel({
                channelId: vc.id, guildId, adapterCreator: ctx.guild.voiceAdapterCreator,
            });
            await entersState(conn, VoiceConnectionStatus.Ready, 15000);
            const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
            conn.subscribe(player);
            sq = {
                textChannel: ctx.channel, voiceChannel: vc, connection: conn,
                songs: [], player, leaveTimeout: null,
                loop: false, volume: 50, speed: 1.0, pitch: 1.0,
                seekTo: null, ttsFile: null, ffmpegProc: null,
                playStartTime: null, playStartOffset: 0,
            };
            queue.set(guildId, sq);
            player.on(AudioPlayerStatus.Idle, () => {
                const q = queue.get(guildId);
                if (q) {
                    if (q.ffmpegProc) { try { q.ffmpegProc.kill(); } catch {} q.ffmpegProc = null; }
                    if (q.ttsFile) { safeDelete(q.ttsFile); q.ttsFile = null; }
                }
                if (q && q.songs.length === 0) {
                    q.leaveTimeout = setTimeout(() => {
                        const stillQ = queue.get(guildId);
                        if (stillQ && stillQ.songs.length === 0) {
                            stillQ.connection?.destroy();
                            queue.delete(guildId);
                        }
                    }, 30000);
                }
            });
        }

        const currentSong = sq.songs.length > 0 ? sq.songs[0] : null;
        if (currentSong && currentSong.filePath && sq.playStartTime) {
            const pos = getCurrentPosition(sq);
            sq._restarting = true;
            if (sq.ffmpegProc) { try { sq.ffmpegProc.kill(); } catch { } sq.ffmpegProc = null; }

            const ffArgs = ['-ss', String(Math.max(0, pos))];
            ffArgs.push('-i', currentSong.filePath); // entrada 0: música
            ffArgs.push('-i', ttsPath);               // entrada 1: TTS
            // Aplicar speed/pitch a la música, mezclar con TTS
            const musicFilters = [];
            if (sq.speed !== 1.0) {
                let s = sq.speed;
                while (s < 0.5) { musicFilters.push('atempo=0.5'); s /= 0.5; }
                while (s > 2.0) { musicFilters.push('atempo=2.0'); s /= 2.0; }
                musicFilters.push(`atempo=${s.toFixed(4)}`);
            }
            if (sq.pitch !== 1.0) {
                musicFilters.push(`asetrate=48000*${sq.pitch}`, 'aresample=48000');
            }
            musicFilters.push('volume=0.35');
            const ttsFilter = 'volume=2.5,aformat=channel_layouts=stereo';
            ffArgs.push('-filter_complex',
                `[0:a]${musicFilters.join(',')}[m];[1:a]${ttsFilter}[t];[m][t]amix=inputs=2:duration=shortest:dropout_transition=2[out]`);
            ffArgs.push('-map', '[out]', '-f', 'opus', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', 'pipe:1');

            const proc = spawn(ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
            sq.ffmpegProc = proc;
            sq.ttsFile = ttsPath;
            sq.ttsResumeOffset = pos; // Guardar posición de la música antes de que TTS la sobreescriba
            const resource = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
            resource.volume?.setVolume(sq.volume / 50);
            sq.player.play(resource);
            sq._restarting = false;
            sq.playStartTime = Date.now();
            sq.playStartOffset = pos;
            proc.on('error', () => { });
        } else {
            // No hay música sonando — reproducir TTS por ffmpeg para salida estéreo
            sq.ttsFile = ttsPath;
            const ttsProc = spawn(ffmpegPath, ['-i', ttsPath, '-ac', '2', '-f', 'opus', '-c:a', 'libopus', '-ar', '48000', '-b:a', '128k', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
            sq.ffmpegProc = ttsProc;
            const resource = createAudioResource(ttsProc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
            resource.volume?.setVolume(sq.volume / 50);
            ttsProc.on('error', () => { });
            sq.player.play(resource);
        }
        ctx.reply({ embeds: [new EmbedBuilder().setColor(THEME.accent).setDescription(`🗣️ Diciendo: *${fmt(truncated, 60)}*`)] });
    } catch (e) {
        safeDelete(ttsPath);
        ctx.reply({ embeds: [errEmbed(`Falló el TTS: ${e.message}`)] });
    }
}

// ─── Embed de error ───────────────────────────────────────────────
function errEmbed(msg) {
    return new EmbedBuilder()
        .setColor(THEME.danger)
        .setDescription(msg);
}

// ════════════════════════════════════════════════════════════════════
// MÓDULO DE MODERACIÓN Y REGISTRO (integrado del bot Administrator)
// ════════════════════════════════════════════════════════════════════

const ETHERNAL_GUILD_ID = '1511109290704896010';

// Canales de logs dedicados (Ethernal)
const LOG_CHANNELS = {
    MOD_LOGS: '1511872792054726827',   // 𝗠𝗼𝗱『𝗟𝗼𝗴𝘀』
    MSG_LOGS: '1511872930865352774',   // 𝗠𝗦𝗚『𝗟𝗼𝗴𝘀』
    JOIN_LEFT: '1511404561745711204',  // 『👋』bienvenidos
    VC_LOGS: '1511872995369418823',    // 𝗩𝗖-𝗜𝗻ﾉ𝗢𝘂𝘁『𝗟𝗼𝗴𝘀』
    ADMIN_LOGS: '1511872683116200008', // 𝗔𝗱𝗺𝗶𝗻『𝗟𝗼𝗴𝘀』
};

// Roles de moderación (planos: ambos tienen autoridad total)
const MOD_ROLES = {
    CREADOR: '1511377184600752128',
    CO_OWNER: '1511375931564888214',
};

// Auto-asignación de roles al entrar
const AUTO_ROLES = {
    USUARIOS: '1511404537120817334',       // humanos
    ETHERNAL_BOTS: '1511404539624947823',  // bots
};

const MODC = { GREEN: 0x9B59B6, RED: 0x8B0000, ORANGE: 0xFF8008, PURPLE: 0x8A2387, BLUE: 0x4E65FF };
const WARNING_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // los avisos expiran a los 7 días
const MOD_COMMANDS = new Set(['warn', 'warnings', 'clear-warnings', 'kick', 'ban', 'mute', 'unmute']);

// ─── Persistencia de avisos / watchlist en MongoDB ───
const warningSchema = new mongoose.Schema({
    guildId: String, userId: String, warnId: String,
    moderatorId: String, reason: String, timestamp: Number,
});
const Warning = mongoose.model('Warning', warningSchema);
const watchlistSchema = new mongoose.Schema({
    guildId: String, userId: String, addedAt: Number, addedBy: String, reason: String,
});
const WatchlistEntry = mongoose.model('WatchlistEntry', watchlistSchema);

function getExpirationString(warn) {
    const remainingMs = WARNING_DURATION_MS - (Date.now() - warn.timestamp);
    if (remainingMs <= 0) return 'Expirado';
    const hours = Math.ceil(remainingMs / (1000 * 60 * 60));
    if (hours <= 24) return `${hours} hora(s) restantes`;
    return `${Math.ceil(hours / 24)} día(s) restantes`;
}

async function getWarnings(guildId, userId) {
    const cutoff = Date.now() - WARNING_DURATION_MS;
    await Warning.deleteMany({ guildId, userId, timestamp: { $lt: cutoff } });
    const list = await Warning.find({ guildId, userId }).sort({ timestamp: 1 }).lean();
    if (list.length < 3) await WatchlistEntry.deleteOne({ guildId, userId });
    return list;
}

async function addWarning(guildId, userId, moderatorMember, reason) {
    const warnId = Math.random().toString(36).substring(2, 9).toUpperCase();
    await Warning.create({ guildId, userId, warnId, moderatorId: moderatorMember.id, reason, timestamp: Date.now() });
    const active = await getWarnings(guildId, userId);
    if (active.length >= 3) {
        await WatchlistEntry.updateOne(
            { guildId, userId },
            { $setOnInsert: { addedAt: Date.now(), addedBy: moderatorMember.id, reason: 'Acumuló 3+ avisos en 7 días' } },
            { upsert: true }
        );
    }
    return { warnId, activeCount: active.length };
}

async function clearWarnings(guildId, userId) {
    await Warning.deleteMany({ guildId, userId });
    await WatchlistEntry.deleteOne({ guildId, userId });
}

// ─── Permisos: modelo plano de 2 roles ───
function isModerator(member) {
    if (!member) return false;
    if (member.id === OWNER_ID) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    return member.roles.cache.has(MOD_ROLES.CREADOR) || member.roles.cache.has(MOD_ROLES.CO_OWNER);
}

function checkTarget(targetMember, executorMember) {
    if (!targetMember) return { ok: true };
    if (targetMember.id === client.user.id) return { ok: false, reason: 'No puedes moderar al propio bot.' };
    if (targetMember.id === executorMember.id) return { ok: false, reason: 'No puedes moderarte a ti mismo.' };
    if (targetMember.id === OWNER_ID && executorMember.id !== OWNER_ID) return { ok: false, reason: 'No puedes moderar al dueño del bot.' };
    return { ok: true };
}

// ─── Utilidades de duración (sustituyen al paquete `ms`) ───
function humanizeDuration(msVal) {
    msVal = Math.abs(msVal);
    const s = Math.floor(msVal / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d} día${d !== 1 ? 's' : ''}`;
    if (h > 0) return `${h} hora${h !== 1 ? 's' : ''}`;
    if (m > 0) return `${m} minuto${m !== 1 ? 's' : ''}`;
    return `${s} segundo${s !== 1 ? 's' : ''}`;
}
function parseDuration(str) {
    if (!str) return null;
    const mt = String(str).trim().match(/^(\d+)\s*([smhdw])$/i);
    if (!mt) return null;
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[mt[2].toLowerCase()];
    return parseInt(mt[1]) * mult;
}

function modEmbed(title, description, color = MODC.GREEN, fields = []) {
    const e = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
    if (description) e.setDescription(description);
    if (fields.length > 0) e.addFields(fields);
    return e;
}

async function getLoggingChannel(guild, eventType) {
    const map = { mod: LOG_CHANNELS.MOD_LOGS, msg: LOG_CHANNELS.MSG_LOGS, join_leave: LOG_CHANNELS.JOIN_LEFT, vc: LOG_CHANNELS.VC_LOGS, admin: LOG_CHANNELS.ADMIN_LOGS };
    const id = map[eventType];
    if (id) { try { const c = await guild.channels.fetch(id); if (c) return c; } catch { } }
    return null;
}

async function sendAdminLog(guild, embed) {
    try { const c = await getLoggingChannel(guild, 'admin'); if (c) await c.send({ embeds: [embed] }); }
    catch (err) { console.error('[Mod] Falló admin-log:', err.message); }
}

async function getAuditLogEntry(guild, actionType, targetId = null, maxTimeDiffMs = 7000) {
    try {
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
        const logs = await guild.fetchAuditLogs({ limit: 5, type: actionType });
        const now = Date.now();
        for (const entry of logs.entries.values()) {
            if (targetId && entry.target && entry.target.id !== targetId) continue;
            if (now - entry.createdTimestamp < maxTimeDiffMs) return entry;
        }
    } catch (e) { console.error('[Mod] Falló audit log:', e.message); }
    return null;
}

function getPermissionOverwritesDiff(oldChannel, newChannel) {
    const diffs = [];
    const oldO = oldChannel.permissionOverwrites.cache;
    const newO = newChannel.permissionOverwrites.cache;
    for (const [id, n] of newO.entries()) {
        const o = oldO.get(id);
        const t = n.type === 0 ? 'Rol' : 'Miembro';
        const mention = n.type === 0 ? `<@&${id}>` : `<@${id}>`;
        if (!o) {
            const allowed = n.allow.toArray(), denied = n.deny.toArray();
            let d = `➕ **Permisos añadidos para ${t}** ${mention}:\n`;
            if (allowed.length) d += `  • **Permitido**: \`${allowed.join(', ')}\`\n`;
            if (denied.length) d += `  • **Denegado**: \`${denied.join(', ')}\`\n`;
            diffs.push(d);
        } else {
            const oa = o.allow.toArray(), od = o.deny.toArray(), na = n.allow.toArray(), nd = n.deny.toArray();
            const aA = na.filter(p => !oa.includes(p)), aR = oa.filter(p => !na.includes(p));
            const dA = nd.filter(p => !od.includes(p)), dR = od.filter(p => !nd.includes(p));
            if (aA.length || aR.length || dA.length || dR.length) {
                let d = `⚙️ **Permisos modificados para ${t}** ${mention}:\n`;
                if (aA.length) d += `  • **Permitido +**: \`${aA.join(', ')}\`\n`;
                if (aR.length) d += `  • **Permitido -**: \`${aR.join(', ')}\`\n`;
                if (dA.length) d += `  • **Denegado +**: \`${dA.join(', ')}\`\n`;
                if (dR.length) d += `  • **Denegado -**: \`${dR.join(', ')}\`\n`;
                diffs.push(d);
            }
        }
    }
    for (const [id, o] of oldO.entries()) {
        if (!newO.has(id)) {
            const t = o.type === 0 ? 'Rol' : 'Miembro';
            const mention = o.type === 0 ? `<@&${id}>` : `<@${id}>`;
            diffs.push(`➖ **Eliminados todos los permisos para ${t}** ${mention}`);
        }
    }
    return diffs;
}

// ─── Caché de mensajes (para deletes/edits rápidos) ───
const modMessageCache = new Map();
const MOD_MAX_CACHE = 5000;
client.on('messageCreate', (message) => {
    if (!message.guild || message.author?.bot) return;
    modMessageCache.set(message.id, {
        content: message.content, author: message.author, channel: message.channel,
        attachments: message.attachments.map(a => ({ name: a.name, url: a.url })),
    });
    if (modMessageCache.size > MOD_MAX_CACHE) modMessageCache.delete(modMessageCache.keys().next().value);
});

// 1. Mensaje borrado
client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    const logChannel = await getLoggingChannel(message.guild, 'msg');
    if (!logChannel) return;
    let author = message.author, content = message.content, attachments = message.attachments;
    const cached = modMessageCache.get(message.id);
    if (cached) { author = cached.author; content = cached.content; attachments = cached.attachments; modMessageCache.delete(message.id); }
    const authorDisplay = author ? `${author} (\`${author.id}\`)` : 'Autor desconocido (sin caché)';
    const auditEntry = await getAuditLogEntry(message.guild, AuditLogEvent.MessageDelete, author?.id);
    const deletedBy = auditEntry ? auditEntry.executor : null;
    const embed = modEmbed('🗑️ Mensaje Borrado',
        `**Autor**: ${authorDisplay}\n**Canal**: ${message.channel}\n` +
        `**Borrado por**: ${deletedBy ? `${deletedBy} (\`${deletedBy.id}\`)` : 'Autor (propio/app)'}\n` +
        `**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>\n\n**Contenido**:\n${content ? content.substring(0, 1500) : '*Sin caché o vacío*'}`,
        MODC.RED);
    if (author) embed.setThumbnail(author.displayAvatarURL({ dynamic: true }));
    if (attachments && (attachments.size > 0 || attachments.length > 0)) {
        const list = Array.isArray(attachments) ? attachments : Array.from(attachments.values());
        embed.addFields({ name: 'Adjuntos', value: list.map(a => `[${a.name}](${a.url})`).join(', ').substring(0, 1024) });
    }
    logChannel.send({ embeds: [embed] }).catch(console.error);
});

// 2. Mensaje editado
client.on('messageUpdate', async (oldMessage, newMessage) => {
    const guild = newMessage.guild || oldMessage.guild;
    if (!guild) return;
    const author = newMessage.author || oldMessage.author;
    if (!author || author.bot) return;
    if (oldMessage.content === newMessage.content) return;
    const logChannel = await getLoggingChannel(guild, 'msg');
    if (!logChannel) return;
    let oldContent = oldMessage.content;
    const cached = modMessageCache.get(oldMessage.id);
    if (cached && !oldContent) oldContent = cached.content;
    modMessageCache.set(newMessage.id, {
        content: newMessage.content, author, channel: newMessage.channel || oldMessage.channel,
        attachments: newMessage.attachments.map(a => ({ name: a.name, url: a.url })),
    });
    const embed = modEmbed('✏️ Mensaje Editado',
        `**Autor**: ${author} (\`${author.id}\`)\n**Canal**: ${newMessage.channel || oldMessage.channel}\n` +
        `**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>\n**Enlace**: [Ir al mensaje](${newMessage.url})\n\n` +
        `**Antes**:\n${oldContent ? oldContent.substring(0, 1000) : '*Sin caché*'}\n\n**Después**:\n${newMessage.content ? newMessage.content.substring(0, 1000) : '*Vacío*'}`,
        MODC.ORANGE);
    embed.setThumbnail(author.displayAvatarURL({ dynamic: true }));
    logChannel.send({ embeds: [embed] }).catch(console.error);
});

// 3. Miembro entra + auto-rol
client.on('guildMemberAdd', async (member) => {
    const logChannel = await getLoggingChannel(member.guild, 'join_leave');
    const isBot = member.user.bot;
    const roleIdToAssign = isBot ? AUTO_ROLES.ETHERNAL_BOTS : AUTO_ROLES.USUARIOS;
    const roleName = isBot ? 'Ethernal Bots' : 'Usuarios';
    let roleGranted = false, roleError = null;
    try {
        if (member.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            await member.roles.add(roleIdToAssign); roleGranted = true;
        } else roleError = 'El bot no tiene permiso de Gestionar Roles';
    } catch (err) { roleError = err.message; }
    if (roleGranted) {
        await sendAdminLog(member.guild, modEmbed('🛡️ Rol Concedido',
            `**Rol**: <@&${roleIdToAssign}>\n**Objetivo**: ${member.user}\n**Moderador**: <@${client.user.id}>\n**ID de Rol**: ${roleIdToAssign}`, MODC.GREEN));
    }
    if (!logChannel) return;
    const ageMs = Date.now() - member.user.createdAt.getTime();
    const embed = modEmbed(isBot ? '🤖 Bot Añadido' : '📥 Miembro Entró', `${member.user} se unió al servidor!`, MODC.GREEN, [
        { name: 'Usuario', value: member.user.tag, inline: true },
        { name: 'ID', value: `\`${member.id}\``, inline: true },
        { name: 'Cuenta Creada', value: `${member.user.createdAt.toUTCString()} (hace ${humanizeDuration(ageMs)})` },
        { name: 'Auto-Rol', value: roleGranted ? `✅ Rol **${roleName}** concedido.` : `❌ Falló **${roleName}**: ${roleError || 'Desconocido'}` },
    ]);
    if (!isBot && ageMs < 1000 * 60 * 60 * 24 * 3) embed.addFields({ name: '⚠️ Alerta', value: '¡Esta cuenta fue creada hace muy poco!' });
    logChannel.send({ embeds: [embed] }).catch(console.error);
});

// 4. Miembro sale / expulsado
client.on('guildMemberRemove', async (member) => {
    const logChannel = await getLoggingChannel(member.guild, 'join_leave');
    if (!logChannel) return;
    const kickEntry = await getAuditLogEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    const timeInServer = member.joinedTimestamp ? humanizeDuration(Date.now() - member.joinedTimestamp) : 'Desconocido';
    const rolesList = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'Sin roles';
    const avatarUrl = member.user.displayAvatarURL({ dynamic: true });
    if (kickEntry) {
        const modChannel = await getLoggingChannel(member.guild, 'mod');
        const embed = modEmbed('🚪 Miembro Expulsado',
            `**Objetivo**: ${member.user} (\`${member.id}\`)\n**Expulsado por**: ${kickEntry.executor} (\`${kickEntry.executor.id}\`)\n` +
            `**Tiempo en servidor**: \`${timeInServer}\`\n**Roles**: ${rolesList}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>\n\n**Razón**: ${kickEntry.reason || 'Sin razón'}`,
            MODC.RED);
        embed.setThumbnail(avatarUrl);
        if (modChannel) modChannel.send({ embeds: [embed] }).catch(console.error);
    } else {
        const embed = modEmbed('📤 Miembro Salió',
            `**Usuario**: ${member.user} (\`${member.id}\`)\n**Entró**: ${member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:f>` : 'Desconocido'}\n` +
            `**Duración**: \`${timeInServer}\`\n**Roles**: ${rolesList}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`,
            MODC.RED);
        embed.setThumbnail(avatarUrl);
        logChannel.send({ embeds: [embed] }).catch(console.error);
    }
});

// 5. Ban
client.on('guildBanAdd', async (ban) => {
    const logChannel = await getLoggingChannel(ban.guild, 'mod');
    if (!logChannel) return;
    const entry = await getAuditLogEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    const embed = modEmbed('🚫 Miembro Baneado',
        `**Objetivo**: ${ban.user} (\`${ban.user.id}\`)\n**Baneado por**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n` +
        `**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>\n\n**Razón**: ${entry?.reason || 'Sin razón'}`, MODC.RED);
    embed.setThumbnail(ban.user.displayAvatarURL({ dynamic: true }));
    logChannel.send({ embeds: [embed] }).catch(console.error);
});

// 6. Unban
client.on('guildBanRemove', async (ban) => {
    const logChannel = await getLoggingChannel(ban.guild, 'mod');
    if (!logChannel) return;
    const entry = await getAuditLogEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const embed = modEmbed('🔓 Miembro Desbaneado',
        `**Objetivo**: ${ban.user} (\`${ban.user.id}\`)\n**Desbaneado por**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`,
        MODC.GREEN);
    embed.setThumbnail(ban.user.displayAvatarURL({ dynamic: true }));
    logChannel.send({ embeds: [embed] }).catch(console.error);
});

// 7. Actualización de miembro (apodo, roles, timeout)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.partial) { try { oldMember = await oldMember.fetch(); } catch { return; } }
    if (newMember.partial) { try { newMember = await newMember.fetch(); } catch { return; } }
    // Apodo
    if (oldMember.nickname !== newMember.nickname) {
        const modChannel = await getLoggingChannel(newMember.guild, 'mod');
        if (modChannel) {
            const entry = await getAuditLogEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
            const embed = modEmbed('👤 Apodo Actualizado',
                `**Usuario**: ${newMember.user} (\`${newMember.user.id}\`)\n` + (entry?.executor ? `**Moderador**: ${entry.executor} (\`${entry.executor.id}\`)\n` : '') +
                `**Antes**: \`${oldMember.nickname || 'Ninguno'}\`\n**Después**: \`${newMember.nickname || 'Ninguno'}\`\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`,
                MODC.ORANGE);
            embed.setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }));
            modChannel.send({ embeds: [embed] }).catch(console.error);
        }
    }
    // Roles
    const oldRoles = oldMember.roles.cache, newRoles = newMember.roles.cache;
    if (oldRoles.size !== newRoles.size) {
        const added = newRoles.filter(r => !oldRoles.has(r.id)).filter(r => !r.managed);
        const removed = oldRoles.filter(r => !newRoles.has(r.id)).filter(r => !r.managed);
        const entry = await getAuditLogEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
        for (const [roleId] of added) {
            await sendAdminLog(newMember.guild, modEmbed('🛡️ Rol Concedido',
                `**Rol**: <@&${roleId}>\n**Objetivo**: ${newMember.user}\n` + (entry?.executor ? `**Moderador**: ${entry.executor}\n` : '') + `**ID de Rol**: ${roleId}`, MODC.GREEN));
        }
        for (const [roleId, role] of removed) {
            await sendAdminLog(newMember.guild, modEmbed('🛡️ Rol Removido',
                `**Rol**: ${role.name}\n**Objetivo**: ${newMember.user}\n` + (entry?.executor ? `**Moderador**: ${entry.executor}\n` : '') + `**ID de Rol**: ${roleId}`, MODC.RED));
        }
    }
    // Timeout
    const oldT = oldMember.communicationDisabledUntil, newT = newMember.communicationDisabledUntil;
    if (oldT !== newT) {
        const modChannel = await getLoggingChannel(newMember.guild, 'mod');
        if (modChannel) {
            const avatarUrl = newMember.user.displayAvatarURL({ dynamic: true });
            if (newT && (!oldT || oldT.getTime() !== newT.getTime())) {
                const entry = await getAuditLogEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
                const embed = modEmbed('🔇 Miembro Silenciado',
                    `**Usuario**: ${newMember.user} (\`${newMember.user.id}\`)\n**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n` +
                    `**Duración**: \`${humanizeDuration(newT.getTime() - Date.now())}\`\n**Hasta**: <t:${Math.floor(newT.getTime() / 1000)}:f>\n\n**Razón**: ${entry?.reason || 'Sin razón'}`,
                    MODC.ORANGE);
                embed.setThumbnail(avatarUrl);
                modChannel.send({ embeds: [embed] }).catch(console.error);
            } else if (!newT && oldT) {
                const entry = await getAuditLogEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
                const embed = modEmbed('🔊 Silencio Removido',
                    `**Usuario**: ${newMember.user} (\`${newMember.user.id}\`)\n**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`,
                    MODC.GREEN);
                embed.setThumbnail(avatarUrl);
                modChannel.send({ embeds: [embed] }).catch(console.error);
            }
        }
    }
});

// 8. Estados de voz (registro)
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member || member.id === client.user.id) return; // no registrar al propio bot
    const guild = newState.guild || oldState.guild;
    const logChannel = await getLoggingChannel(guild, 'vc');
    if (!logChannel) return;
    const user = member.user;
    const avatarUrl = user.displayAvatarURL({ dynamic: true });
    let embed = null;
    if (!oldState.channelId && newState.channelId) {
        embed = modEmbed('📥 Entró a Canal de Voz',
            `**Usuario**: ${user} (\`${user.id}\`)\n**Canal**: ${newState.channel}\n**Miembros**: \`${newState.channel?.members.size || 0}\`\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, 0x2ECC71);
    } else if (oldState.channelId && !newState.channelId) {
        const disc = await getAuditLogEntry(guild, AuditLogEvent.MemberDisconnect, member.id, 5000);
        if (disc) {
            const modChannel = await getLoggingChannel(guild, 'mod');
            if (modChannel) {
                const d = modEmbed('❌ Desconectado de Voz',
                    `**Usuario**: ${user} (\`${user.id}\`)\n**Moderador**: ${disc.executor} (\`${disc.executor.id}\`)\n**Canal**: ${oldState.channel}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.RED);
                d.setThumbnail(avatarUrl);
                modChannel.send({ embeds: [d] }).catch(console.error);
            }
        }
        embed = modEmbed('📤 Salió de Canal de Voz',
            `**Usuario**: ${user} (\`${user.id}\`)\n**Canal**: ${oldState.channel}\n**Miembros**: \`${oldState.channel?.members.size || 0}\`\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.RED);
    } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const entry = await getAuditLogEntry(guild, AuditLogEvent.MemberMove, null, 5000);
        let desc = `**Usuario**: ${user} (\`${user.id}\`)\n**De**: ${oldState.channel}\n**A**: ${newState.channel}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`;
        if (entry && entry.executor.id !== member.id) desc += `\n**Movido por**: ${entry.executor} (\`${entry.executor.id}\`)`;
        embed = modEmbed('🔀 Cambió de Canal de Voz', desc, MODC.ORANGE);
    }
    if (oldState.channelId && newState.channelId && oldState.serverMute !== newState.serverMute) {
        const modChannel = await getLoggingChannel(guild, 'mod');
        if (modChannel) {
            const entry = await getAuditLogEntry(guild, AuditLogEvent.MemberUpdate, member.id);
            modChannel.send({ embeds: [modEmbed(newState.serverMute ? '🎤❌ Silenciado en Servidor' : '🎤 Des-silenciado',
                `**Usuario**: ${user} (\`${user.id}\`)\n**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.ORANGE)] }).catch(console.error);
        }
    }
    if (oldState.channelId && newState.channelId && oldState.serverDeaf !== newState.serverDeaf) {
        const modChannel = await getLoggingChannel(guild, 'mod');
        if (modChannel) {
            const entry = await getAuditLogEntry(guild, AuditLogEvent.MemberUpdate, member.id);
            modChannel.send({ embeds: [modEmbed(newState.serverDeaf ? '🔇 Ensordecido en Servidor' : '🔊 Des-ensordecido',
                `**Usuario**: ${user} (\`${user.id}\`)\n**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.ORANGE)] }).catch(console.error);
        }
    }
    if (embed) { embed.setThumbnail(avatarUrl); logChannel.send({ embeds: [embed] }).catch(console.error); }
});

// 9. Canales
client.on('channelCreate', async (channel) => {
    if (!channel.guild) return;
    const logChannel = await getLoggingChannel(channel.guild, 'admin');
    if (!logChannel) return;
    const entry = await getAuditLogEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    logChannel.send({ embeds: [modEmbed('🆕 Canal Creado',
        `**Canal**: ${channel} (\`#${channel.name}\`)\n**Tipo**: \`${ChannelType[channel.type] || 'Desconocido'}\`\n**Categoría**: ${channel.parent ? channel.parent.name : 'Ninguna'}\n` +
        `**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.GREEN)] }).catch(console.error);
});
client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    const logChannel = await getLoggingChannel(channel.guild, 'admin');
    if (!logChannel) return;
    const entry = await getAuditLogEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    logChannel.send({ embeds: [modEmbed('🗑️ Canal Eliminado',
        `**Nombre**: \`${channel.name}\`\n**Tipo**: \`${ChannelType[channel.type] || 'Desconocido'}\`\n**Moderador**: ${entry ? `${entry.executor} (\`${entry.executor.id}\`)` : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>`, MODC.RED)] }).catch(console.error);
});
client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!oldChannel.guild) return;
    const logChannel = await getLoggingChannel(newChannel.guild, 'admin');
    if (!logChannel) return;
    let changed = false;
    const entry = await getAuditLogEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    let desc = `**Canal**: ${newChannel} (\`#${newChannel.name}\`)\n**Moderador**: ${entry ? entry.executor : 'Desconocido'}\n**Hora**: <t:${Math.floor(Date.now() / 1000)}:f>\n\n`;
    if (oldChannel.name !== newChannel.name) { desc += `📝 **Nombre**:\n• Antes: \`${oldChannel.name}\`\n• Después: \`${newChannel.name}\`\n\n`; changed = true; }
    if (oldChannel.topic !== newChannel.topic) { desc += `📝 **Tema**:\n• Antes: \`${oldChannel.topic || 'Ninguno'}\`\n• Después: \`${newChannel.topic || 'Ninguno'}\`\n\n`; changed = true; }
    const overwrites = getPermissionOverwritesDiff(oldChannel, newChannel);
    if (overwrites.length) { desc += `🔒 **Permisos actualizados**:\n${overwrites.join('\n')}\n\n`; changed = true; }
    if (!changed) return;
    if (desc.length <= 4000) logChannel.send({ embeds: [modEmbed('⚙️ Canal Actualizado', desc, MODC.ORANGE)] }).catch(console.error);
    else logChannel.send({ embeds: [modEmbed('⚙️ Canal Actualizado', desc.substring(0, 3800) + '\n*(continúa...)*', MODC.ORANGE), modEmbed('⚙️ Canal Actualizado (2)', '*(...)*\n\n' + desc.substring(3800), MODC.ORANGE)] }).catch(console.error);
});

// 10. Roles
client.on('roleCreate', async (role) => {
    const entry = role.managed ? null : await getAuditLogEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
    await sendAdminLog(role.guild, modEmbed('🎨 Rol Creado',
        `**Rol**: <@&${role.id}>\n` + (entry?.executor ? `**Moderador**: ${entry.executor} (\`${entry.executor.id}\`)\n` : '') + `**ID de Rol**: ${role.id}` + (role.managed ? '\n*(Rol de integración)*' : ''), MODC.GREEN));
});
client.on('roleDelete', async (role) => {
    const entry = role.managed ? null : await getAuditLogEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
    await sendAdminLog(role.guild, modEmbed('🗑️ Rol Eliminado',
        `**Rol**: ${role.name}\n` + (entry?.executor ? `**Moderador**: ${entry.executor} (\`${entry.executor.id}\`)\n` : '') + `**ID de Rol**: ${role.id}` + (role.managed ? '\n*(Rol de integración)*' : ''), MODC.RED));
});
client.on('roleUpdate', async (oldRole, newRole) => {
    const entry = await getAuditLogEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const executor = entry ? entry.executor : 'Desconocido';
    if (oldRole.name !== newRole.name)
        await sendAdminLog(newRole.guild, modEmbed('⚙️ Rol Actualizado', `Nombre cambiado por **${executor}**.\n\n**Antes**\n${oldRole.name}\n\n**Después**\n${newRole.name}\n\n**ID de Rol**: ${newRole.id}`, MODC.ORANGE));
    if (oldRole.hexColor !== newRole.hexColor)
        await sendAdminLog(newRole.guild, modEmbed('⚙️ Rol Actualizado', `Color cambiado por **${executor}**.\n\n**Antes**\n${oldRole.hexColor}\n\n**Después**\n${newRole.hexColor}\n\n**ID de Rol**: ${newRole.id}`, MODC.ORANGE));
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        const added = newRole.permissions.toArray().filter(p => !oldRole.permissions.has(p));
        const removed = oldRole.permissions.toArray().filter(p => !newRole.permissions.has(p));
        if (added.length || removed.length) {
            let d = `Permisos cambiados por **${executor}**.\n\n`;
            if (added.length) d += `**Añadidos**:\n+ ${added.join('\n+ ')}\n\n`;
            if (removed.length) d += `**Removidos**:\n- ${removed.join('\n- ')}\n\n`;
            d += `**ID de Rol**: ${newRole.id}`;
            await sendAdminLog(newRole.guild, modEmbed('⚙️ Rol Actualizado', d, MODC.ORANGE));
        }
    }
});

// ─── Comandos de moderación ───
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!MOD_COMMANDS.has(interaction.commandName)) return;
    const { commandName, options, guild, member, user } = interaction;
    if (!guild) return interaction.reply({ content: '❌ Los comandos de moderación solo funcionan en servidores.', ephemeral: true });
    if (!isModerator(member)) {
        return interaction.reply({ embeds: [modEmbed('❌ Permiso Denegado', 'Necesitas el rol **Creador** o **Co-Owner** para usar comandos de moderación.', MODC.RED)], ephemeral: true });
    }
    try {
        if (commandName === 'warn') {
            const targetMember = options.getMember('target');
            const reason = options.getString('reason');
            if (!targetMember) return interaction.reply({ content: '❌ No se encontró a ese miembro.', ephemeral: true });
            const t = checkTarget(targetMember, member);
            if (!t.ok) return interaction.reply({ content: `❌ ${t.reason}`, ephemeral: true });
            const warnInfo = await addWarning(guild.id, targetMember.id, member, reason);
            const embed = modEmbed('⚠️ Miembro Avisado', '', MODC.ORANGE, [
                { name: 'Usuario', value: `${targetMember.user} (\`${targetMember.id}\`)`, inline: true },
                { name: 'Staff', value: `${user} (\`${user.id}\`)`, inline: true },
                { name: 'ID Aviso', value: `\`${warnInfo.warnId}\``, inline: true },
                { name: 'Avisos Activos', value: `\`${warnInfo.activeCount}\``, inline: true },
                { name: 'Razón', value: reason },
            ]);
            await interaction.reply({ embeds: [embed] });
            const logChannel = await getLoggingChannel(guild, 'mod');
            if (logChannel) logChannel.send({ embeds: [embed] }).catch(console.error);
            await targetMember.send(`⚠️ Has sido avisado en **${guild.name}** por: *${reason}*`).catch(() => { });
        }
        else if (commandName === 'warnings') {
            const targetUser = options.getUser('target');
            const history = await getWarnings(guild.id, targetUser.id);
            const embed = modEmbed(`📋 Avisos de ${targetUser.tag}`,
                history.length === 0 ? 'Historial limpio. 0 avisos activos.' : `Este usuario tiene **${history.length}** aviso(s).`, MODC.BLUE);
            history.forEach((warn, i) => embed.addFields({
                name: `Aviso #${i + 1} [ID: ${warn.warnId}]`,
                value: `• **Moderador**: <@${warn.moderatorId}>\n• **Fecha**: ${new Date(warn.timestamp).toUTCString()}\n• **Estado**: ${getExpirationString(warn)}\n• **Razón**: *${warn.reason}*`,
            }));
            await interaction.reply({ embeds: [embed] });
        }
        else if (commandName === 'clear-warnings') {
            const targetUser = options.getUser('target');
            await clearWarnings(guild.id, targetUser.id);
            const embed = modEmbed('🧼 Avisos Borrados', `Se borraron todos los avisos activos de ${targetUser}.`, MODC.GREEN, [{ name: 'Staff', value: `${user} (\`${user.id}\`)` }]);
            await interaction.reply({ embeds: [embed] });
            const logChannel = await getLoggingChannel(guild, 'mod');
            if (logChannel) logChannel.send({ embeds: [embed] }).catch(console.error);
        }
        else if (commandName === 'kick') {
            const targetMember = options.getMember('target');
            const reason = options.getString('reason') || 'Sin razón';
            if (!targetMember) return interaction.reply({ content: '❌ No se encontró a ese miembro.', ephemeral: true });
            const t = checkTarget(targetMember, member);
            if (!t.ok) return interaction.reply({ content: `❌ ${t.reason}`, ephemeral: true });
            if (!targetMember.kickable) return interaction.reply({ content: '❌ No puedo expulsar a este usuario (jerarquía de roles).', ephemeral: true });
            await targetMember.kick(`${reason} | Mod: ${user.tag}`);
            await interaction.reply({ embeds: [modEmbed('🥾 Miembro Expulsado', '', MODC.RED, [
                { name: 'Usuario', value: `${targetMember.user} (\`${targetMember.id}\`)`, inline: true },
                { name: 'Staff', value: `${user} (\`${user.id}\`)`, inline: true }, { name: 'Razón', value: reason }])] });
        }
        else if (commandName === 'ban') {
            const targetUser = options.getUser('target');
            const reason = options.getString('reason') || 'Sin razón';
            const deleteDays = options.getInteger('delete_messages') || 0;
            const targetMember = guild.members.cache.get(targetUser.id);
            const t = checkTarget(targetMember, member);
            if (!t.ok) return interaction.reply({ content: `❌ ${t.reason}`, ephemeral: true });
            if (targetMember && !targetMember.bannable) return interaction.reply({ content: '❌ No puedo banear a este usuario.', ephemeral: true });
            await guild.members.ban(targetUser.id, { deleteMessageSeconds: deleteDays * 86400, reason: `${reason} | Mod: ${user.tag}` });
            await interaction.reply({ embeds: [modEmbed('🚫 Miembro Baneado', '', MODC.RED, [
                { name: 'Usuario', value: `${targetUser} (\`${targetUser.id}\`)`, inline: true },
                { name: 'Staff', value: `${user} (\`${user.id}\`)`, inline: true }, { name: 'Razón', value: reason }])] });
        }
        else if (commandName === 'mute') {
            const targetMember = options.getMember('target');
            const durationStr = options.getString('duration');
            const reason = options.getString('reason') || 'Sin razón';
            if (!targetMember) return interaction.reply({ content: '❌ No se encontró a ese miembro.', ephemeral: true });
            const t = checkTarget(targetMember, member);
            if (!t.ok) return interaction.reply({ content: `❌ ${t.reason}`, ephemeral: true });
            const durationMs = parseDuration(durationStr);
            if (!durationMs || durationMs < 5000 || durationMs > 28 * 86400000) return interaction.reply({ content: '❌ Duración inválida. Ej: 10m, 1h, 12h, 7d (máx 28d).', ephemeral: true });
            if (!targetMember.moderatable) return interaction.reply({ content: '❌ No puedo silenciar a este miembro.', ephemeral: true });
            await targetMember.timeout(durationMs, `${reason} | Mod: ${user.tag}`);
            await interaction.reply({ embeds: [modEmbed('🔇 Miembro Silenciado', 'Restringido de enviar mensajes en todos los canales.', MODC.ORANGE, [
                { name: 'Usuario', value: `${targetMember.user} (\`${targetMember.id}\`)`, inline: true },
                { name: 'Duración', value: `\`${humanizeDuration(durationMs)}\``, inline: true },
                { name: 'Staff', value: `${user} (\`${user.id}\`)`, inline: true }, { name: 'Razón', value: reason }])] });
        }
        else if (commandName === 'unmute') {
            const targetMember = options.getMember('target');
            const reason = options.getString('reason') || 'Sin razón';
            if (!targetMember) return interaction.reply({ content: '❌ No se encontró a ese miembro.', ephemeral: true });
            if (!targetMember.communicationDisabledUntil) return interaction.reply({ content: '❌ Ese miembro no está silenciado.', ephemeral: true });
            await targetMember.timeout(null, `${reason} | Mod: ${user.tag}`);
            await interaction.reply({ embeds: [modEmbed('🔊 Silencio Removido', '', MODC.GREEN, [
                { name: 'Usuario', value: `${targetMember.user} (\`${targetMember.id}\`)`, inline: true },
                { name: 'Staff', value: `${user} (\`${user.id}\`)`, inline: true }])] });
        }
    } catch (err) {
        console.error(`[Mod] /${commandName}:`, err.message);
        const payload = { content: `❌ Operación fallida: ${err.message}`, ephemeral: true };
        if (interaction.replied || interaction.deferred) interaction.followUp(payload).catch(() => { });
        else interaction.reply(payload).catch(() => { });
    }
});

client.login(TOKEN);
