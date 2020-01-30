require('./lib/configFileCreator')()
require('dotenv').config()

const fs = require('fs')
const util = require('util')
const { promisify } = require('util')

const readFileAsync = promisify(fs.readFile)
const NodeCache = require('node-cache')
const fastify = require('fastify')()
const Telegraf = require('telegraf')

const telegramCommandParser = require('./lib/telegram/middleware/commandParser')
const telegramController = require('./lib/telegram/middleware/controller')

const Config = require('./lib/configFetcher')
const mustache = require('./lib/handlebars')()
const Telegram = require('./lib/telegram/Telegram')

let {
	config, knex, dts, geofence, translator,
} = Config()

const readDir = util.promisify(fs.readdir)

const telegraf = new Telegraf(config.telegram.token, { channelMode: true })


const cache = new NodeCache({ stdTTL: 5400 })

const discordCache = new NodeCache({ stdTTL: config.discord.limitSec })

const DiscordWorker = require('./lib/discord/DiscordWorker')
const DiscordCommando = require('./lib/discord/commando/')

const { log, webhooks } = require('./lib/logger')
const monsterData = require('./util/monsters')
const utilData = require('./util/util')


const MonsterController = require('./controllers/monster')
const RaidController = require('./controllers/raid')
const QuestController = require('./controllers/quest')
const PokestopController = require('./controllers/pokestop')


const monsterController = new MonsterController(knex, config, dts, geofence, monsterData, discordCache, translator, mustache)
const raidController = new RaidController(knex, config, dts, geofence, monsterData, discordCache, translator, mustache)
const questController = new QuestController(knex, config, dts, geofence, monsterData, discordCache, translator, mustache)
const pokestopController = new PokestopController(knex, config, dts, geofence, monsterData, discordCache, translator, mustache)

fastify.decorate('logger', log)
fastify.decorate('webhooks', webhooks)
fastify.decorate('config', config)
fastify.decorate('knex', knex)
fastify.decorate('cache', cache)
fastify.decorate('monsterController', monsterController)
fastify.decorate('raidController', raidController)
fastify.decorate('questController', questController)
fastify.decorate('pokestopController', pokestopController)
fastify.decorate('dts', dts)
fastify.decorate('geofence', geofence)
fastify.decorate('translator', translator)
fastify.decorate('discordQueue', [])
fastify.decorate('telegramQueue', [])
fastify.decorate('hookQueue', [])

let discordCommando = config.discord.enabled ? DiscordCommando(knex, config, log, monsterData, utilData, dts, geofence, translator) : null
log.info(`Discord commando ${discordCommando ? '' : ''}starting`)
let discordWorkers = []
let telegram
let workingOnHooks = false

if (config.discord.enabled) {
	for (const key in config.discord.token) {
		if (config.discord.token[key]) {
			discordWorkers.push(new DiscordWorker(config.discord.token[key], key, config))
		}
	}
}

if (config.telegram.enabled) {
	telegram = new Telegram(config, log, dts, telegramController, monsterController, telegraf, translator, telegramCommandParser)
	log.info(telegram)
}

fs.watch('./config/', async (event, fileName) => {
	if (!fileName.endsWith('.json')) return
	discordWorkers = []
	discordCommando = null

	const newFile = await readFileAsync(`./config/${fileName}`, 'utf8')
	try {
		JSON.parse(newFile)
		const newConfigs = Config()

		config = newConfigs.config
		knex = newConfigs.knex
		dts = newConfigs.dts
		geofence = newConfigs.geofence
		translator = newConfigs.translator

		for (const key in config.discord.token) {
			if (config.discord.token[key]) {
				discordWorkers.push(new DiscordWorker(config.discord.token[key], key, config))
			}
		}
		discordCommando = DiscordCommando(knex, config, log, monsterData, utilData, dts, geofence, translator)
		fastify.config = config
		fastify.knex = knex
		fastify.dts = dts
		fastify.geofence = geofence
		fastify.translator = translator
	} catch (err) {
		log.warn('new config file unhappy: ', err)
	}
})

async function run() {
	setInterval(() => {
		if (!fastify.discordQueue.length) {
			return
		}
		const target = !fastify.discordQueue.slice(-1).shift()[0]
		// see if target has dedicated worker
		let worker = discordWorkers.find((workerr) => workerr.users.includes(target.id))
		if (!worker) {
			worker = discordWorkers.reduce((prev, curr) => (prev.users.length < curr.users.length ? prev : curr))
			worker.addUser(target.id)
		}
		if (!worker.busy) worker.work(fastify.discordQueue.shift())
	}, 10)

	const routeFiles = await readDir(`${__dirname}/routes/`)
	const routes = routeFiles.map((fileName) => `${__dirname}/routes/${fileName}`)

	routes.forEach((route) => fastify.register(require(route)))
	await fastify.listen(config.server.port, config.server.host)
	log.info(`Service started on ${fastify.server.address().address}:${fastify.server.address().port}`)
}

async function handleAlarms() {
	if (Math.random() * 10 > 6) fastify.log.debug(`WebhookQueue is currently ${fastify.hookQueue.length}`)
	if (fastify.hookQueue.length && !workingOnHooks) {
		const hook = fastify.hookQueue.shift()
		switch (hook.type) {
			case 'pokemon': {
				fastify.webhooks.info('pokemon', hook.message)
				if (fastify.cache.get(`${hook.message.encounter_id}_${hook.message.disappear_time}_${hook.message.weight}`)) {
					fastify.logger.warn(`Wild encounter ${hook.message.encounter_id} was sent again too soon, ignoring`)
					break
				}

				fastify.cache.set(`${hook.message.encounter_id}_${hook.message.disappear_time}_${hook.message.weight}`, hook)

				const result = await fastify.monsterController.handle(hook.message)
				result.forEach((job) => {
					if (['discord:user', 'discord:channel', 'webhook'].includes(job.type)) fastify.discordQueue.push(job)
					if (['telegram:user', 'telegram:channel'].includes(job.type)) fastify.telegramQueue.push(job)
				})

				break
			}
			case 'raid': {
				fastify.webhooks.info('raid', hook.message)
				if (fastify.cache.get(`${hook.message.gym_id}_${hook.message.end}_${hook.message.pokemon_id}`)) {
					fastify.logger.info(`Raid ${hook.message.encounter_id} was sent again too soon, ignoring`)
					break
				}

				fastify.cache.set(`${hook.message.gym_id}_${hook.message.end}_${hook.message.pokemon_id}`, hook)

				const result = await fastify.raidController.handle(hook.message)
				result.forEach((job) => {
					if (['discord:user', 'discord:channel', 'webhook'].includes(job.type)) fastify.discordQueue.push(job)
					if (['telegram:user', 'telegram:channel'].includes(job.type)) fastify.telegramQueue.push(job)
				})
				break
			}
			case 'invasion':
			case 'pokestop': {
				fastify.webhooks.info('pokestop', hook.message)
				const incidentExpiration = hook.message.incident_expiration ? hook.message.incident_expiration : hook.message.incident_expire_timestamp
				if (!incidentExpiration) break
				if (await fastify.cache.get(`${hook.message.pokestop_id}_${incidentExpiration}`)) {
					fastify.logger.info(`Invasion at ${hook.message.pokestop_id} was sent again too soon, ignoring`)
					break
				}
				fastify.cache.set(`${hook.message.pokestop_id}_${incidentExpiration}`, 'cached')

				const result = await fastify.pokestopController.handle(hook.message)

				result.forEach((job) => {
					if (['discord:user', 'discord:channel', 'webhook'].includes(job.type)) fastify.discordQueue.push(job)
					if (['telegram:user', 'telegram:channel'].includes(job.type)) fastify.telegramQueue.push(job)
				})

				break
			}
			case 'quest': {
				fastify.webhooks.info('quest', hook.message)
				if (await fastify.cache.get(`${hook.message.pokestop_id}_${JSON.stringify(hook.message.rewards)}`)) {
					fastify.logger.info(`Quest at ${hook.message.pokestop_name} was sent again too soon, ignoring`)
					break
				}
				fastify.cache.set(`${hook.message.pokestop_id}_${JSON.stringify(hook.message.rewards)}`, 'cached')
				const q = hook.message

				const result = await fastify.questController.handle(q)
				result.forEach((job) => {
					if (['discord:user', 'discord:channel', 'webhook'].includes(job.type)) fastify.discordQueue.push(job)
					if (['telegram:user', 'telegram:channel'].includes(job.type)) fastify.telegramQueue.push(job)
				})
				break
			}
			case 'weather': {
				fastify.webhooks.info('weather', hook.message)
				await fastify.weatherController.handle(hook.message)
				break
			}
			default:
		}
		workingOnHooks = false
	}
}

run()
setInterval(handleAlarms, 1)
