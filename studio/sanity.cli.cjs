const {defineCliConfig} = require('sanity/cli')

const projectId = process.env.SANITY_STUDIO_PROJECT_ID || ''
const dataset = process.env.SANITY_STUDIO_DATASET || 'production'

module.exports = defineCliConfig({
  api: {projectId: projectId || 'placeholder', dataset}
})
