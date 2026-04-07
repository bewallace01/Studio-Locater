import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes/index.js'

const projectId = process.env.SANITY_STUDIO_PROJECT_ID || ''
const dataset = process.env.SANITY_STUDIO_DATASET || 'production'

/** Ensures the browser bundle can read the key (Vite does not always expose ad-hoc SANITY_STUDIO_* vars). */
const googleMapsBrowserKey = process.env.SANITY_STUDIO_GOOGLE_MAPS_API_KEY || ''

export default defineConfig({
  name: 'studio-locater',
  title: 'Studio Locater CMS',
  projectId: projectId || 'placeholder',
  dataset,
  plugins: [structureTool()],
  schema: {types: schemaTypes},
  vite: (prev) => ({
    ...prev,
    define: {
      ...prev.define,
      'import.meta.env.SANITY_STUDIO_GOOGLE_MAPS_API_KEY': JSON.stringify(googleMapsBrowserKey)
    }
  })
})
