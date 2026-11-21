#!/usr/bin/env python3
"""
Build a THEME PACK: the same art set as the sci-fi base, drawn for another setting.

A pack is a folder of sheets in designs/<theme>/ on the SAME grids and under the SAME sprite
names as the base set, so nothing in the app knows which theme it is drawing — a greenhouse is a
`greenhouse` whether it is a dome on an outpost or a herbalist's glasshouse. This script runs the
three base builders (kit, crew, decks) with the pack's sheet list and writes:

    dashboard/public/world/<theme>/terrain.jpg, kit/, crew/, bridge/
    dashboard/src/world/kit.<theme>.generated.ts          KIT_<THEME>
    dashboard/src/world/crewAtlas.<theme>.generated.ts    CREW_ATLAS_<THEME>
    dashboard/src/world/bridge/bridge.<theme>.generated.ts DECK_ART_<THEME>

world/theme.ts picks the pack at page load; a sprite a pack does not draw falls back to the base.

Usage: python3 scripts/world/build_theme_pack.py fantasy
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import build_world_kit as kit
import build_crew_sheets as crew
import build_bridge as bridge

PACKS = {
    'fantasy': {
        'terrain': 'terrain.png',
        'kit': {
            'buildings-a.png': (2, 2, ['greenhouse', 'habitat', 'generator', 'gate']),
            'buildings-b.png': (2, 2, ['shuttle', 'pad', 'module', 'workshop']),
            'props-a.png': (3, 3, ['planter', 'tripod', 'water-station', 'hut', 'toolbox', 'dish', 'rover', 'tunnel', 'lamp']),
            'props-b.png': (4, 4, [
                'crate-1', 'crate-2', 'crate-3', 'crate-pile',
                'crate-open', 'crate-glow', 'cart-1', 'cart-3',
                'cell-full', 'cell-half', 'cell-low', 'beacon',
                'marker-green', 'marker-yellow', 'marker-red', 'sign',
            ]),
            'airship-anim.png': (4, 3, [
                'shuttle-0', 'shuttle-1', 'shuttle-2', 'shuttle-3',
                'flame-0', 'flame-1', 'flame-2', 'flame-3',
                'dust-0', 'dust-1', 'dust-2', 'dust-3',
            ]),
            'gate-anim.png': (2, 2, ['gate-0', 'gate-1', 'gate-2', 'gate-3']),
            'items.png': (3, 3, ['holo-table', 'bench', 'bench-back', 'heater', 'dispenser', 'plant', 'banner', 'signpost', 'fog-pylon']),
            'deadline-candle.png': (4, 2, ['gauge-0', 'gauge-1', 'gauge-2', 'gauge-3', 'gauge-4', 'gauge-5', 'gauge-6', 'gauge-7']),
            'locked-gate.png': (4, 1, ['airlock-0', 'airlock-1', 'airlock-2', 'airlock-3']),
            'celebration.png': (4, 2, ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'pennant-0', 'pennant-1', 'pennant-2', 'pennant-3']),
            'rewards.png': (3, 3, ['trophy', 'medal', 'insignia', 'statue', 'fountain', 'light-arch', 'signal-tower', 'crew-banners', 'garden']),
        },
        # The base character ids, each drawn as its counterpart: the app hands out `mechanic`,
        # `pilot` and `scout`; in this pack they are the blacksmith, the ranger and the apothecary.
        'crew': {
            'mechanic': {'key': 'magenta', 'base': 'blacksmith-base.png', 'floor': 'blacksmith-floor.png', 'attention': 'blacksmith-attention.png', 'seat': 'blacksmith-sit.png'},
            'pilot': {'key': 'magenta', 'base': 'ranger-base.png', 'floor': 'ranger-floor.png', 'attention': 'ranger-attention.png', 'seat': 'ranger-sit.png'},
            'scout': {'key': 'magenta', 'base': 'apothecary-base.png', 'floor': 'apothecary-floor.png', 'attention': 'apothecary-attention.png', 'seat': 'apothecary-sit.png'},
        },
        'decks': {
            'captain': [('guildmaster-sheet.png', ['idle', 'brief', 'call']), ('guildmaster-sheet-2.png', ['log', 'celebrate', 'worry'])],
            'engineer': ('artificer-sheet.png', ['idle', 'work', 'call']),
            'core': ('crystal-sheet.png', ['low', 'normal', 'high', 'warn']),
            'quartermaster': ('storekeeper-sheet.png', ['idle', 'work', 'call']),
        },
        'backdrops': {'projects': 'guild-hall.png', 'workflows': 'workshop.png', 'tokens': 'crystal-chamber.png', 'tasks': 'storehouse.png'},
    },
}


def main(theme):
    pack = PACKS[theme]
    designs = os.path.join(ROOT, 'designs', theme)
    dashboard = os.path.join(ROOT, 'dashboard')

    kit.THEME, kit.SHEETS, kit.TERRAIN, kit.TERRAIN_HD = theme, pack['kit'], pack['terrain'], 'terrain-4k.png'
    kit.main(designs, dashboard)

    crew.THEME, crew.SOURCES = theme, pack['crew']
    crew.main(designs, dashboard)

    bridge.THEME, bridge.SHEETS, bridge.BACKDROPS = theme, pack['decks'], pack['backdrops']
    bridge.main(designs, dashboard)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'fantasy')
