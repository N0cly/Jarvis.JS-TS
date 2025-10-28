// src/commands/fun/hanime.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    ChannelType,
} from "discord.js";

// Listes de catégories
const CATS = {
    sfw: [
        "waifu","neko","shinobu","megumin","bully","cuddle","cry","hug","awoo","kiss",
        "lick","pat","smug","bonk","yeet","blush","smile","wave","highfive","handhold",
        "nom","bite","glomp","slap","kill","kick","happy","wink","poke","dance","cringe",
    ],
    nsfw: ["waifu", "neko", "trap", "blowjob"],
} as const;

type TypeKey = keyof typeof CATS;

// Appel API
async function getWaifuPicsUrl(type: TypeKey, category: string): Promise<string> {
    const url = `https://api.waifu.pics/${type}/${category}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { url?: string };
    if (!data?.url) throw new Error("Réponse API invalide (pas d'url).");
    return data.url;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("hanime")
        .setDescription("Image waifu.pics avec options dépendantes")
        .addStringOption(opt =>
            opt.setName("type")
                .setDescription("sfw ou nsfw")
                .setRequired(true)
                .addChoices({ name: "sfw", value: "sfw" }, { name: "nsfw", value: "nsfw" }),
        )
        .addStringOption(opt =>
            opt.setName("category")
                .setDescription("Catégorie (dépend de 'type')")
                .setRequired(true)
                .setAutocomplete(true),
        ),

    // Autocomplete pour 'category'
    async autocomplete(interaction: AutocompleteInteraction) {
        const focused = interaction.options.getFocused();
        const type = (interaction.options.getString("type") as TypeKey | null) ?? "sfw";
        const pool = CATS[type];

        const filtered = pool
            .filter(c => c.toLowerCase().includes(focused.toLowerCase()))
            .slice(0, 25)
            .map(c => ({ name: c, value: c }));

        await interaction.respond(filtered);
    },

    // Exécution de la commande
    async execute(interaction: ChatInputCommandInteraction) {
        const type = interaction.options.getString("type", true) as TypeKey;
        const category = interaction.options.getString("category", true);

        // Sécurité : catégorie valide
        const allowed = new Set(CATS[type]);
        if (!allowed.has(category)) {
            return interaction.reply({
                content: `❌ La catégorie \`${category}\` n'est pas autorisée pour \`${type}\`.`,
                ephemeral: true,
            });
        }

        // Vérif NSFW (autorisé en DM)
        if (
            type === "nsfw" &&
            interaction.channel &&
            interaction.channel.type !== ChannelType.DM &&
            // @ts-expect-error: propriété nsfw sur salons texte guild
            interaction.channel.nsfw !== true
        ) {
            return interaction.reply({
                content: "⚠️ Cette commande **NSFW** doit être utilisée en DM ou dans un salon **NSFW**.",
                ephemeral: true,
            });
        }

        await interaction.deferReply();
        try {
            const imageUrl = await getWaifuPicsUrl(type, category);
            const embed = new EmbedBuilder()
                // .setTitle("waifu.pics")
                // .setDescription(`type: **${type}** — catégorie: **${category}**`)
                .setImage(imageUrl)
                .setColor(type === "nsfw" ? 0xff55aa : 0x55ffaa)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err: any) {
            await interaction.editReply({ content: `❌ Erreur API: ${err?.message ?? err}` });
        }
    },
};
