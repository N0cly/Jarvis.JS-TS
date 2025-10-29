import {
    SlashCommandBuilder,
    ChannelType,
    PermissionsBitField,
    ChatInputCommandInteraction
} from "discord.js";
import {
    createAudioPlayer,
    createAudioResource,
    joinVoiceChannel,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    entersState,
    demuxProbe,
    AudioPlayerStatus
} from "@discordjs/voice";
import path from "node:path";
import * as play from "play-dl";
import ytdl from "ytdl-core";

/** URL YouTube ? (gère youtube.com, youtu.be, m.youtube.com, nocookie) */
export function isYouTubeUrl(s: string): boolean {
    try {
        const u = new URL(s);
        const host = u.hostname.toLowerCase();
        return (
            host === "youtu.be" ||
            host.endsWith("youtube.com") ||
            host.endsWith("youtube-nocookie.com") ||
            host.startsWith("m.youtube.com")
        );
    } catch {
        return false;
    }
}

/** Crée une AudioResource depuis une URL YouTube. Tente play-dl puis fallback ytdl-core. */
export async function getYouTubeResource(url: string) {
    // 1) Essai play-dl (rapide + type auto)
    try {
        const stream = await play.stream(url, { discordPlayerCompatibility: true });
        return createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: true,
        });
    } catch (e1) {
        // 2) Fallback ytdl-core (robuste)
        try {
            const stream = ytdl(url, {
                filter: "audioonly",
                quality: "highestaudio",
                highWaterMark: 1 << 25, // évite des underflows
            });
            const probe = await demuxProbe(stream as any);
            return createAudioResource(probe.stream, {
                inputType: probe.type,
                inlineVolume: true,
            });
        } catch (e2) {
            const msg = (e1 as Error)?.message || (e2 as Error)?.message || "Unknown error";
            throw new Error(`YouTube stream failed: ${msg}`);
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Joue un son dans ton salon vocal (YouTube URL ou fichier local).")
        .addStringOption(o =>
            o.setName("input")
                .setDescription("Lien YouTube (https://...) ou nom de fichier (ex: music.mp3)")
                .setRequired(true)
        )
        .addIntegerOption(o =>
            o.setName("volume")
                .setDescription("Volume (0 à 100, défaut 50)")
                .setMinValue(0)
                .setMaxValue(100)
                .setRequired(false)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        // 1) Checks vocal + permissions
        // @ts-expect-error: voice est présent sur GuildMember
        const voiceChannel = interaction.member?.voice?.channel;
        if (
            !voiceChannel ||
            (voiceChannel.type !== ChannelType.GuildVoice &&
                voiceChannel.type !== ChannelType.GuildStageVoice)
        ) {
            return interaction.reply({
                content: "Tu dois être **dans un salon vocal**.",
                ephemeral: true
            });
        }

        const perms = voiceChannel.permissionsFor(interaction.client.user!.id);
        if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
            return interaction.reply({
                content: "Je n’ai pas la permission **Connect**/**Speak** dans ce salon.",
                ephemeral: true
            });
        }

        const input = interaction.options.getString("input", true).trim();
        const volumePct = interaction.options.getInteger("volume") ?? 50;
        const vol = Math.max(0, Math.min(100, volumePct)) / 100;

        console.log(input)

        await interaction.deferReply();

        // 2) Connexion au vocal
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: true
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch {
            connection.destroy();
            return interaction.editReply("Impossible de se connecter au vocal (timeout).");
        }

        // 3) Player
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
        const sub = connection.subscribe(player);
        if (!sub) {
            connection.destroy();
            return interaction.editReply("Erreur: impossible de s’abonner au player.");
        }

        // 4) Resource selon input (YouTube ou fichier local)
        let resourceTitle = input;
        try {
            let resource;


            // Info pour le titre (facultatif)
            try {
                const v = await play.video_info(input);
                if (v.video_details?.title) resourceTitle = v.video_details.title;
            } catch { /* ignore title fetch errors */ }

            resource = await getYouTubeResource(input);


            // Volume puis lecture
            resource.volume?.setVolume(vol);
            player.play(resource);

            // Events
            player.on("error", (err) => {
                console.error("Audio Player Error:", err);
                connection.destroy();
            });

            player.on(AudioPlayerStatus.Idle, () => {
                // Quitter à la fin de la lecture. Retire ce destroy si tu veux rester connecté.
                connection.destroy();
            });

            await interaction.editReply(`▶️ Lecture de **${resourceTitle}** à **${Math.round(vol * 100)}%** dans **${voiceChannel.name}**`);
        } catch (err: any) {
            console.error(err);
            connection.destroy();
            await interaction.editReply(`❌ Impossible de jouer **${resourceTitle}**.\n\`${err?.message ?? err}\``);
        }
    }
};
