import {Client, Events, ActivityType} from 'discord.js';

function formatUptime(totalSeconds: number) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client: Client) {
        console.log(`Ready! Logged in as ${client.user!.tag}`);

        // Intervalle de rotation (ms) : configurable via .env
        const ROTATE_MS = Number(process.env.PRESENCE_ROTATE_MS ?? 10000); // 30s par défaut
        const start = Date.now();

        // Liste des “templates” de statuts. On injecte l’uptime à chaque tick.
        const buildStatuses = (uptimeStr: string) => ([
            { type: ActivityType.Watching,  name: `uptime: ${uptimeStr}` },
            { type: ActivityType.Playing,   name: `/help • ${client.guilds.cache.size} serveurs` },
            { type: ActivityType.Playing,    name: `🚀 Uptime ${uptimeStr}` }, // statut personnalisé
            { type: ActivityType.Listening, name: `les logs • ping ${client.ws.ping}ms` },
        ]);

        let i = 0;
        const tick = () => {
            const seconds = Math.floor((Date.now() - start) / 1000);
            const uptimeStr = formatUptime(seconds);
            const statuses = buildStatuses(uptimeStr);

            const next = statuses[i % statuses.length];

            client.user?.setPresence({
                status: 'online',
                activities: [{ type: next.type, name: next.name! }],
            });

            i++;
        };

        // Premier set immédiat, puis rotation
        tick();
        setInterval(tick, ROTATE_MS);
    },
};