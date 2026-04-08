import {defineField, defineType} from 'sanity'
import {GeopointGeocodeInput} from '../components/GeopointGeocodeInput.jsx'
import {PlaceIdGoogleInput} from '../components/PlaceIdGoogleInput.jsx'

export const studio = defineType({
  name: 'studio',
  title: 'Studio',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {source: 'name', maxLength: 96}
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 3
    }),
    defineField({
      name: 'cardImage',
      title: 'Card image',
      type: 'image',
      options: {hotspot: true},
      description: 'Hero image on search cards. If empty, the site uses a Google Places photo when available.'
    }),
    defineField({
      name: 'reviewHighlight',
      title: 'Review highlight',
      type: 'string',
      description: 'Short quote for cards (e.g. a favorite review line). Optional.'
    }),
    defineField({
      name: 'experienceLevel',
      title: 'Experience level',
      type: 'string',
      description:
        'Who classes suit best — summarize from Google/Yelp reviews and your own visits. Sets you apart from raw listings.',
      options: {
        list: [
          {title: '— Not set —', value: ''},
          {title: 'Beginner-friendly', value: 'beginner'},
          {title: 'All levels welcome', value: 'all_levels'},
          {title: 'Mixed (some challenging options)', value: 'mixed'},
          {title: 'Intermediate & up', value: 'intermediate'},
          {title: 'Advanced-focused', value: 'advanced'}
        ]
      }
    }),
    defineField({
      name: 'vibeTags',
      title: 'Studio vibes',
      type: 'array',
      of: [{type: 'string'}],
      options: {layout: 'tags'},
      description: 'Atmosphere & personality (e.g. cozy, high-energy, neighborhood gem).'
    }),
    defineField({
      name: 'classTips',
      title: 'Class tips',
      type: 'text',
      rows: 4,
      description:
        'Practical notes: parking, what to bring, locker situation, culture — sourced from reviews and editors.'
    }),
    defineField({
      name: 'address',
      title: 'Address',
      type: 'address',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'location',
      title: 'Map location',
      type: 'geopoint',
      description:
        'Optional. Use “Geocode address → map location” after filling the address, or drag the pin. If empty, the public site can still geocode the address when users search (slower).',
      components: {input: GeopointGeocodeInput}
    }),
    defineField({
      name: 'placeId',
      title: 'Google Place ID',
      type: 'string',
      description: 'Matches this studio to Google Places for the public search API.',
      validation: Rule => Rule.max(256),
      components: {input: PlaceIdGoogleInput}
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{type: 'string'}],
      options: {layout: 'tags'},
      initialValue: ['Yoga']
    }),
    defineField({
      name: 'rating',
      title: 'Rating',
      type: 'number',
      validation: Rule => Rule.min(0).max(5).precision(1),
      initialValue: 4.5
    }),
    defineField({
      name: 'reviews',
      title: 'Review count',
      type: 'number',
      initialValue: 50
    }),
    defineField({
      name: 'priceTier',
      title: 'Price tier',
      type: 'number',
      description: '1 = $, 2 = $$, 3 = $$$',
      validation: Rule => Rule.min(1).max(3).integer(),
      initialValue: 2
    }),
    defineField({
      name: 'featured',
      title: 'Featured',
      type: 'boolean',
      initialValue: false
    }),
    defineField({
      name: 'badge',
      title: 'Badge text',
      type: 'string',
      description: 'Shown on the card when Featured is on (e.g. Editor pick)',
      hidden: ({parent}) => !parent?.featured
    })
  ],
  preview: {
    select: {
      title: 'name',
      line1: 'address.streetLine1',
      city: 'address.city',
      region: 'address.region'
    },
    prepare({title, line1, city, region}) {
      const sub = [line1, city, region].filter(Boolean).join(' · ')
      return {title, subtitle: sub || 'No address'}
    }
  }
})
