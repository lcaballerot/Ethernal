# Ethernal

Bot de Discord **multipropósito** para el clan **Ethernal**: reproductor de música + sistema completo de **moderación y registro (logs)**, todo en un solo proceso.

---

## ⚠️ Información sensible

Por seguridad, **estos archivos NO están en el repositorio** (están en `.gitignore`) y deben crearse manualmente en cada despliegue:

| Archivo | Contenido | Cómo obtenerlo |
|---|---|---|
| `.env` | `DISCORD_TOKEN`, `MONGO_URL` | Token desde el [Discord Developer Portal](https://discord.com/developers/applications) |
| `res/BOT_TOKEN.md` | Token del bot (alternativa al `.env`) | Igual que arriba |
| `cookies.txt` | Cookies de YouTube (necesarias para reproducir) | Generadas con `update_cookies.js` |
| `*.pem` | Clave SSH para desplegar en el servidor | Privada, nunca compartir |

> Sin token el bot no arranca; sin `cookies.txt` la reproducción de YouTube falla.

---

## ✨ Funcionalidades

### 🎵 Música
- `/play` · `!play` — Reproduce o encola una canción (YouTube, con respaldo en SoundCloud; acepta URLs y playlists).
- `/skip` · `/stop` · `/queue` · `/np` · `/ping` · `/help`.
- **Premium** (gestionado por el dueño con `/premium @usuario`): `/loop`, `/volume`, `/speed`, `/pitch`, `/set`, `/tts`.

### 🛡️ Moderación
Disponible **solo** para los roles **Creador** y **Co-Owner** (ambos con autoridad total), el dueño del bot, o cualquier miembro con permiso de **Administrador**:
- `/warn` · `/warnings` · `/clear-warnings` — Avisos (expiran a los 7 días, persistidos en MongoDB).
- `/kick` · `/ban` · `/mute` (timeout, ej. `10m`, `1h`, `1d`) · `/unmute`.

### 📋 Registro (logs) automático
Eventos enviados a canales dedicados:
- **MSG**: mensajes borrados y editados.
- **Join/Leave**: entradas, salidas y expulsiones (+ alerta de cuentas nuevas).
- **VC**: entrar/salir/mover de voz, mute/deafen de servidor, desconexiones por moderador.
- **Mod**: bans/unbans, timeouts, cambios de apodo.
- **Admin**: creación/edición/borrado de canales y roles, asignación/retiro de roles.

### 🎭 Auto-roles al entrar
- Humanos → **Usuarios**
- Bots → **Ethernal Bots**

---

## 📦 Requisitos

- **Node.js 20+**
- **ffmpeg** y **yt-dlp** (en Linux: binarios del sistema; en Windows: incluidos/`yt-dlp.exe`)
- **MongoDB** (para premium, avisos y watchlist)
- Una **aplicación de Discord** con:
  - **Intents privilegiados activados** en el Developer Portal: **Server Members Intent** y **Message Content Intent**.
  - Permisos del bot en el servidor: **Kick Members, Ban Members, Moderate Members, Manage Roles, View Audit Log, Send Messages, Embed Links, Connect, Speak** (lo más simple: permiso de **Administrador**).
  - El rol del bot debe estar **por encima** de los roles que asigna (`Usuarios`, `Ethernal Bots`) y de los miembros que va a moderar.

> ⚠️ Si los intents privilegiados **no** están activados, `client.login` lanza *"disallowed intents"* y el bot **no arranca** (también se cae la música).

---

## ⚙️ Configuración

El token se lee de `DISCORD_TOKEN` (`.env`) o, si no existe, de `res/BOT_TOKEN.md`.

Las IDs específicas del servidor (guild, roles de moderación, auto-roles y canales de logs) están definidas como constantes al inicio del módulo de moderación en [`index.js`](index.js). Si se recrea el servidor o cambian las IDs, actualízalas ahí.

`.env` de ejemplo:
```env
DISCORD_TOKEN=tu_token_aqui
MONGO_URL=mongodb://ethernal-mongo:27017/ethernal
```

Registro de comandos: los comandos slash se registran automáticamente al arrancar (globales; pueden tardar hasta ~1 hora en aparecer la primera vez).

---

## 🚀 Despliegue (Docker)

El stack usa `docker-compose` con dos servicios: el bot (Node 20 + ffmpeg + yt-dlp) y MongoDB.

1. Clona el repositorio en el servidor.
2. Crea los archivos sensibles que **no** vienen incluidos: `.env`, `cookies.txt` y (opcional) `res/BOT_TOKEN.md`.
3. Levanta el stack:
   ```bash
   docker-compose up --build -d
   ```
4. Ver logs:
   ```bash
   docker-compose logs -f ethernal-bot
   ```

`index.js` y `cookies.txt` se montan como volúmenes, por lo que para actualizar el código basta con reemplazar `index.js` y reiniciar:
```bash
docker-compose restart ethernal-bot
```

### Actualizar cookies de YouTube
```bash
node update_cookies.js
```
Extrae las cookies del navegador, las sube por SFTP y reinicia el contenedor. (Cierra el navegador por completo antes de ejecutarlo.)

---

## 🧑‍💻 Desarrollo local

```bash
npm install
node index.js
```

Requiere `ffmpeg` y `yt-dlp` en el `PATH` (o `yt-dlp.exe` en la carpeta del proyecto en Windows) y una instancia de MongoDB accesible vía `MONGO_URL`.

---

*Autor: LCaballerot*
