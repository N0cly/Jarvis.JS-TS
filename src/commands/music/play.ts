import {
    SlashCommandBuilder,
    ChannelType,
    PermissionsBitField,
    ChatInputCommandInteraction,
} from "discord.js";
import {
    createAudioPlayer,
    createAudioResource,
    joinVoiceChannel,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    entersState,
    demuxProbe,
    AudioPlayerStatus,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import miniget from "miniget";
import ytdlp from "yt-dlp-exec";

/* =========================================================
 * Config HTTP (headers + cookies)
 * =======================================================*/

const YT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * (Optionnel) Cookie YouTube pour age-gate ou région
 * Exemple .env :
 * YT_COOKIE="VISITOR_INFO1_LIVE=...; YSC=...; SAPISID=...;"
 */
const YT_COOKIE = process.env.YT_COOKIE || "";

/* =========================================================
 * Helpers : nettoyer l'entrée + extraire l'ID YouTube
 * =======================================================*/

function sanitizeInput(s: string): string {
    return s
        .trim()
        .replace(/^<|>$/g, "")
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, "");
}

function extractVideoId(raw: string): string {
    const clean = sanitizeInput(raw);

    try {
        const u = new URL(clean);
        const host = u.hostname.toLowerCase();

        // youtu.be/<id>
        if (host === "youtu.be" && u.pathname.length > 1) {
            const id = u.pathname.slice(1);
            if (id && id.length === 11) return id;
        }

        // youtube.com/shorts/<id>
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts[0] === "shorts" && parts[1]?.length === 11) {
            return parts[1];
        }

        // watch?v=<id>
        const v = u.searchParams.get("v");
        if (v?.length === 11) return v;
    } catch {
        // not a full URL
    }

    // ID brut (collé)
    const m = clean.match(/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];

    throw new Error("Ce n’est pas une URL/ID YouTube vidéo valide.");
}

/* =========================================================
 * Lecture via yt-dlp (pas de play-dl / ytdl-core)
 * =======================================================*/

async function getYouTubeResource(input: string) {
    const id = extractVideoId(input);
    const url = `https://www.youtube.com/watch?v=${id}`;

    const addHeader: string[] = [
        `User-Agent: ${YT_UA}`,
        "Accept-Language: fr-FR,fr;q=0.9,en;q=0.8",
    ];
    if (YT_COOKIE) addHeader.push(`Cookie: ${YT_COOKIE}`);

    let mediaUrl = "";
    try {
        // ⚙️ yt-dlp -g bestaudio (URL directe)
        const out = await ytdlp(url, {
            f: "bestaudio/bestaudio*",
            g: true,
            noWarnings: true,
            noCheckCertificates: true,
            noCallHome: true,
            addHeader,
        } as any);

        if (out && typeof out === "object" && "stdout" in out) {
            const stdout = String((out as any).stdout || "");
            mediaUrl = stdout.trim().split("\n").pop() || "";
        }

        if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            throw new Error("yt-dlp n’a pas retourné d’URL média.");
        }
    } catch (e: any) {
        const msg =
            (e?.stderr && e.stderr.toString?.()) ||
            e?.message ||
            String(e);
        throw new Error(`yt-dlp failed: ${msg}`);
    }

    // 🔊 stream HTTP vers Discord
    const reqOpts: any = {
        headers: {
            "user-agent": YT_UA,
            "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
            ...(YT_COOKIE ? { cookie: YT_COOKIE } : {}),
        },
        maxRetries: 3,
        maxRedirects: 5,
    };

    const httpStream = miniget(mediaUrl, reqOpts) as unknown as Readable;
    const probe = await demuxProbe(httpStream);
    return createAudioResource(probe.stream, {
        inputType: probe.type,
        inlineVolume: true,
    });
}

/* =========================================================
 * Commande /play
 * =======================================================*/

module.exports = {
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Joue un son YouTube dans ton salon vocal (URL ou ID).")
        .addStringOption((o) =>
            o
                .setName("input")
                .setDescription("Lien YouTube (https://...) ou ID vidéo (11 caractères)")
                .setRequired(true)
        )
        .addIntegerOption((o) =>
            o
                .setName("volume")
                .setDescription("Volume (0 à 100, défaut 50)")
                .setMinValue(0)
                .setMaxValue(100)
                .setRequired(false)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        // 1) Vérif du salon vocal
        // @ts-expect-error
        const voiceChannel = interaction.member?.voice?.channel;
        if (
            !voiceChannel ||
            (voiceChannel.type !== ChannelType.GuildVoice &&
                voiceChannel.type !== ChannelType.GuildStageVoice)
        ) {
            return interaction.reply({
                content: "Tu dois être **dans un salon vocal**.",
                ephemeral: true,
            });
        }

        const perms = voiceChannel.permissionsFor(interaction.client.user!.id);
        if (
            !perms?.has(PermissionsBitField.Flags.Connect) ||
            !perms?.has(PermissionsBitField.Flags.Speak)
        ) {
            return interaction.reply({
                content: "Je n’ai pas la permission **Connect**/**Speak** dans ce salon.",
                ephemeral: true,
            });
        }

        const inputRaw = interaction.options.getString("input", true);
        const input = sanitizeInput(inputRaw);
        const volumePct = interaction.options.getInteger("volume") ?? 50;
        const vol = Math.max(0, Math.min(100, volumePct)) / 100;

        await interaction.deferReply();

        // 2) Connexion au vocal
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch {
            connection.destroy();
            return interaction.editReply("Impossible de se connecter au vocal (timeout).");
        }

        // 3) Création du player
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        });
        const sub = connection.subscribe(player);
        if (!sub) {
            connection.destroy();
            return interaction.editReply("Erreur: impossible de s’abonner au player.");
        }

        // 4) Lecture YouTube
        let resourceTitle = input;
        try {
            // Récup titre via yt-dlp JSON
            try {
                const id = extractVideoId(input);
                const watchUrl = `https://www.youtube.com/watch?v=${id}`;
                const info = await ytdlp(watchUrl, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCheckCertificates: true,
                    noCallHome: true,
                    addHeader: [
                        `User-Agent: ${YT_UA}`,
                        "Accept-Language: fr-FR,fr;q=0.9,en;q=0.8",
                        ...(YT_COOKIE ? [`Cookie: ${YT_COOKIE}`] : []),
                    ],
                } as any);

                let data: any = info;
                if (info && typeof info === "object" && "stdout" in info) {
                    try {
                        data = JSON.parse(String((info as any).stdout || "{}"));
                    } catch {
                        data = {};
                    }
                }
                if (data?.title) resourceTitle = data.title;
                else if (data?.fulltitle) resourceTitle = data.fulltitle;
            } catch {
                /* ignore titre */
            }

            const resource = await getYouTubeResource(input);
            resource.volume?.setVolume(vol);
            player.play(resource);

            player.on("error", (err) => {
                console.error("Audio Player Error:", err);
                connection.destroy();
            });

            player.on(AudioPlayerStatus.Idle, () => connection.destroy());

            await interaction.editReply(
                `▶️ Lecture de **${resourceTitle}** à **${Math.round(vol * 100)}%** dans **${voiceChannel.name}**`
            );
        } catch (err: any) {
            console.error(err);
            connection.destroy();
            await interaction.editReply(
                `❌ Impossible de jouer **${resourceTitle}**.\n\`${err?.message ?? err}\``
            );
        }
    },
};
