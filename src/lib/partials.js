const fs = require('fs')
const path = require('path')
const stripJsonComments = require('strip-json-comments')

function registerPartials(handlebars) {
	const partialsPath = path.join(__dirname, '../../config/partials.json')
	if (!fs.existsSync(partialsPath)) {
		return
	}

	const partials = JSON.parse(stripJsonComments(fs.readFileSync(partialsPath, 'utf8')))

	// eslint-disable-next-line guard-for-in
	for (const key in partials) {
		handlebars.registerPartial(key, partials[key])
	}
}

exports.registerPartials = registerPartials