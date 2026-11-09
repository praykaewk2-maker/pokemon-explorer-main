const express = require("express");
const path = require("path");

const app = express();
const pokemonTypes = [
    "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison", "ground",
    "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark", "steel", "fairy"
];
let pokemonNamesCache;

app.use(express.static(path.join(__dirname, "dist")));
app.use(express.static(path.join(__dirname, "Public")));

app.get("/api/pokemon/names", async (req, res) => {
    try {
        if (!pokemonNamesCache) {
            pokemonNamesCache = fetch("https://pokeapi.co/api/v2/pokemon?limit=2000")
                .then(response => {
                    if (!response.ok) throw new Error("Could not load Pokémon names");
                    return response.json();
                })
                .then(data => data.results.map(pokemon => pokemon.name))
                .catch(error => {
                    pokemonNamesCache = undefined;
                    throw error;
                });
        }

        res.json(await pokemonNamesCache);
    } catch (error) {
        console.error(error);
        res.status(502).json({ error: "Could not load Pokémon names" });
    }
});

/* =========================
   GET BASIC POKEMON DATA
========================= */

app.get("/api/pokemon", async (req, res) => {
    try {
        const search = req.query.search || "pikachu";

        const response = await fetch(
            `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(
                search.toLowerCase()
            )}`
        );

        if (!response.ok) {
            return res.status(404).json({
                error: "ไม่พบ Pokémon ตัวนี้"
            });
        }

        const data = await response.json();

        res.json(formatPokemon(data));

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "เกิดข้อผิดพลาดในการเชื่อมต่อ API"
        });
    }
});


/* =========================
   GET EVOLUTION + FORMS
========================= */

app.get("/api/pokemon/:name/family", async (req, res) => {
    try {
        const name = req.params.name.toLowerCase();

        // Get Pokémon first
        const pokemonResponse = await fetch(
            `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(name)}`
        );

        if (!pokemonResponse.ok) {
            return res.status(404).json({
                error: "ไม่พบ Pokémon"
            });
        }

        const pokemonData = await pokemonResponse.json();

        // Get species
        const speciesResponse = await fetch(
            pokemonData.species.url
        );

        const speciesData = await speciesResponse.json();

        /* =========================
           EVOLUTION CHAIN
        ========================= */

        const evolutionResponse = await fetch(
            speciesData.evolution_chain.url
        );

        const evolutionData = await evolutionResponse.json();

        const evolutionNames = [];
        const evolutionStageNames = [];

        function collectEvolution(chain, stage = 0) {
            if (!chain) return;

            evolutionNames.push(chain.species.name);
            evolutionStageNames[stage] ??= [];
            evolutionStageNames[stage].push(chain.species.name);

            if (chain.evolves_to && chain.evolves_to.length > 0) {
                chain.evolves_to.forEach(next => {
                    collectEvolution(next, stage + 1);
                });
            }
        }

        collectEvolution(evolutionData.chain);

        // Remove duplicates
        const uniqueEvolutionNames = [
            ...new Set(evolutionNames)
        ];

        const evolutionPokemon = await Promise.all(
            uniqueEvolutionNames.map(async pokemonName => {
                try {
                    const response = await fetch(
                        `https://pokeapi.co/api/v2/pokemon/${pokemonName}`
                    );

                    if (!response.ok) return null;

                    const data = await response.json();

                    return {
                        id: data.id,
                        name: data.name,
                        image:
                            data.sprites.other?.["official-artwork"]
                                ?.front_default ||
                            data.sprites.front_default,
                        types: data.types.map(type => type.type.name)
                    };

                } catch {
                    return null;
                }
            })
        );

        const availableEvolution = evolutionPokemon.filter(Boolean);
        const evolutionByName = new Map(
            availableEvolution.map(pokemon => [pokemon.name, pokemon])
        );
        const evolutionStages = evolutionStageNames.map(stage =>
            stage.map(name => evolutionByName.get(name)).filter(Boolean)
        );

        const damageMultipliers = new Map(
            pokemonTypes.map(type => [type, 1])
        );

        const typeResponses = await Promise.all(
            pokemonData.types.map(type =>
                fetch(`https://pokeapi.co/api/v2/type/${type.type.name}`)
                    .then(response => response.ok ? response.json() : null)
                    .catch(() => null)
            )
        );

        for (const typeData of typeResponses.filter(Boolean)) {
            const relations = typeData.damage_relations;
            for (const type of relations.double_damage_from) {
                damageMultipliers.set(type.name, damageMultipliers.get(type.name) * 2);
            }
            for (const type of relations.half_damage_from) {
                damageMultipliers.set(type.name, damageMultipliers.get(type.name) * 0.5);
            }
            for (const type of relations.no_damage_from) {
                damageMultipliers.set(type.name, 0);
            }
        }

        const weaknesses = [...damageMultipliers]
            .filter(([, multiplier]) => multiplier > 1)
            .map(([type, multiplier]) => ({ type, multiplier }));

        /* =========================
           FORMS / VARIETIES
        ========================= */

        const varieties = speciesData.varieties || [];

        const forms = await Promise.all(
            varieties.map(async variety => {
                try {
                    const response = await fetch(
                        variety.pokemon.url
                    );

                    if (!response.ok) return null;

                    const data = await response.json();

                    return {
                        id: data.id,
                        name: data.name,
                        image:
                            data.sprites.other?.["official-artwork"]
                                ?.front_default ||
                            data.sprites.front_default,
                        types: data.types.map(type => type.type.name)
                    };

                } catch {
                    return null;
                }
            })
        );

        res.json({
            evolution: availableEvolution,
            evolutionStages,
            forms: forms.filter(Boolean),
            weaknesses
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "ไม่สามารถโหลด Evolution / Forms ได้"
        });
    }
});


app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"), error => {
        if (error) next();
    });
});

/* =========================
   FORMAT POKEMON
========================= */

function formatPokemon(data) {
    return {
        id: data.id,

        name: data.name,

        image:
            data.sprites.other?.["official-artwork"]
                ?.front_default ||
            data.sprites.front_default,

        height: data.height,

        weight: data.weight,

        types: data.types.map(type => type.type.name),

        cry: data.cries?.latest || null,

        stats: {
            hp: data.stats[0].base_stat,
            attack: data.stats[1].base_stat,
            defense: data.stats[2].base_stat,
            specialAttack: data.stats[3].base_stat,
            specialDefense: data.stats[4].base_stat,
            speed: data.stats[5].base_stat
        }
    };
}

if (require.main === module) {
    const PORT = process.env.PORT || 3001;

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;