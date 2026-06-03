const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActivityType, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
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
    ],
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

        queue.delete(guildId);
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
            // Quitar botones del mensaje antiguo de "Sonando ahora"
            if (sq.nowPlayingMsg) { sq.nowPlayingMsg.edit({ components: [] }).catch(() => { }); }
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

client.login(TOKEN);
