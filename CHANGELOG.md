# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 0.2.0 (2026-09-02)


### Features

* add BezKassira.by ticket source ([bee0538](https://github.com/rodewitsch/tickets-sniffer-bot/commits/bee0538587c8136305d05d67bf1ed2dad801f3dd))
* deploy bot with Docker Compose, Drizzle ORM, Caddy and Mini App ([003cd66](https://github.com/rodewitsch/tickets-sniffer-bot/commits/003cd661be9a195a2e9a6fff73dc82ad9ef0c554))
* drop manual check, randomize cron intervals ([74a0746](https://github.com/rodewitsch/tickets-sniffer-bot/commits/74a07464e127ba3b843a7dcd1d50e856bdf538c8))
* full Ticketpro source parity via HTML parser and live search ([da8fb46](https://github.com/rodewitsch/tickets-sniffer-bot/commits/da8fb46fb55d9d3bc246d43cf326d46d9ce93361))
* let users write to the developer from the Help section ([d3817e3](https://github.com/rodewitsch/tickets-sniffer-bot/commits/d3817e35355ecf05f2a93718ff3353f7f3c68bab))
* per-city ticket tracking plus check fixes ([9129383](https://github.com/rodewitsch/tickets-sniffer-bot/commits/912938399c89283c12286353266e1525da0efef8))
* show bezKassira event type in mini app search ([81b1f7d](https://github.com/rodewitsch/tickets-sniffer-bot/commits/81b1f7dc3cad7eee5d3f46a609c3f89bef2beb3a))
* show event category in tracked list ([ab43612](https://github.com/rodewitsch/tickets-sniffer-bot/commits/ab436121d5d88aa8bbca9426b671ebe2ee2e26bc))
* show ticketpro event type in mini app search ([0be26ba](https://github.com/rodewitsch/tickets-sniffer-bot/commits/0be26ba34902933789b249c46b8ba181127207e6))


### Bug Fixes

* add webapp logging and harden handleWebAppData ([1b79fa3](https://github.com/rodewitsch/tickets-sniffer-bot/commits/1b79fa3e0adf1134a28571ac76699de54b76f5ff))
* detect real WebApp context to avoid false added toast ([7fb96f4](https://github.com/rodewitsch/tickets-sniffer-bot/commits/7fb96f4f7c9cd856069d1e1e596144a94ad0a5b5))
* encode keyword in callback data and add graceful edit fallback ([429d092](https://github.com/rodewitsch/tickets-sniffer-bot/commits/429d092d93ffdee8ef827f80653c0dbc221a0de7))
* filter irrelevant search results from Ticketpro and BezKassira ([7fd227e](https://github.com/rodewitsch/tickets-sniffer-bot/commits/7fd227ecba38e27a8d15103ede18dcdd2f0cd3fd))
* keep trailing slash on BezKassira event URLs ([88172aa](https://github.com/rodewitsch/tickets-sniffer-bot/commits/88172aae18a81044509b1bc12732e7c2f99cdcc0))
* launch Mini App via KeyboardButton so sendData works ([82015a8](https://github.com/rodewitsch/tickets-sniffer-bot/commits/82015a852c26ceaafb0b303ef72b7a0ec23d1acd))
* make Cancel button on add-source prompt dismiss the proposal ([61ff9df](https://github.com/rodewitsch/tickets-sniffer-bot/commits/61ff9df1dd068fcabe8375c5801b2f7daa7b28ab))
* refresh mini app keyboard after chat-side watch mutations ([e5af6b1](https://github.com/rodewitsch/tickets-sniffer-bot/commits/e5af6b1d38e045a125c8034d803fd1cb6876e756))
* refresh reply keyboard after add/del to sync Mini App list ([4016703](https://github.com/rodewitsch/tickets-sniffer-bot/commits/4016703411add84bce0ea47146f9fec4462a58b7))
* reply 200 immediately and process webhooks in background ([a5b1ac2](https://github.com/rodewitsch/tickets-sniffer-bot/commits/a5b1ac20b2a12cace6ba606e235f69560adef9ea))
* require signed initData and add sendData diagnostics ([1791c21](https://github.com/rodewitsch/tickets-sniffer-bot/commits/1791c21be0bf9347dfb98ebd250579a8ecaa40bd))
* schedule cron checks by Minsk hour ([8062455](https://github.com/rodewitsch/tickets-sniffer-bot/commits/80624550c62ea2bb494bf2e6cf2956405441a63f))
* send single confirmation when adding/muting from chat ([2b950f7](https://github.com/rodewitsch/tickets-sniffer-bot/commits/2b950f79826138bc99377330ea2c3293929f62de))
* show honest send feedback in Mini App add flow ([d2a5098](https://github.com/rodewitsch/tickets-sniffer-bot/commits/d2a509837cf05d37e826748da34a05b1b2710cbe))
* stop ticketpro search venue bleeding from next card ([06c4df9](https://github.com/rodewitsch/tickets-sniffer-bot/commits/06c4df96f57ed9816d91dd74e3477de2b45a47a5))
* tolerate blocked 24afisha host in detail/venue fetches ([26f68c5](https://github.com/rodewitsch/tickets-sniffer-bot/commits/26f68c5857a3ce5be8beb9431b0deaa6821a5c57))
* version MiniApp URL to bust client cache ([0f1a3d6](https://github.com/rodewitsch/tickets-sniffer-bot/commits/0f1a3d6b3ee5466ead0ba093a2a70c850e7dac01))
