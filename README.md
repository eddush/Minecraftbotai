# Minecraftbotai

AI Minecraft bot for Paper/vanilla servers using Mineflayer + Groq.

## Render environment variables

```text
MC_HOST=eddydev.ddns.net
MC_PORT=25565
MC_VERSION=auto
MC_USERNAME=EddyAI
MC_MICROSOFT_EMAIL=        # leave empty only when the server uses online-mode=false
GROQ_API_KEY=              # add this privately in Render
GROQ_MODEL=llama-3.3-70b-versatile
PORT=10000
```

Groq's API is OpenAI-compatible. The default model above is currently listed by Groq as a production model and supports JSON/tool use.

## Minecraft

After the bot joins, a player can type:

```text
!ai follow me
!ai go to 100 70 -20
!ai dig the block at 10 65 10
```

The AI returns a restricted action plan. It cannot execute arbitrary server commands, OP itself, or change server permissions.

## Authentication

If the server has `online-mode=true`, the bot needs a Microsoft account/Minecraft license. Set `MC_MICROSOFT_EMAIL` to that account email. If the server is offline-mode, leave it empty and `MC_USERNAME` is used.

## Render

This project exposes `/health` and `/` so it can run as a Render Web Service. A Free Render Web Service can still spin down after 15 minutes without inbound traffic, so it is not guaranteed to keep a Minecraft bot connected 24/7.
