import {Box, Button, Stack, Text, TextInput} from '@sanity/ui'
import {useToast} from '@sanity/ui'
import {useCallback, useEffect, useRef, useState} from 'react'
import {set, unset} from 'sanity'

let mapsScriptPromise = null

function getMapsApiKey() {
  try {
    const v = import.meta.env?.SANITY_STUDIO_GOOGLE_MAPS_API_KEY
    if (v) return String(v)
  } catch {
    /* ignore */
  }
  if (typeof process !== 'undefined' && process.env?.SANITY_STUDIO_GOOGLE_MAPS_API_KEY) {
    return String(process.env.SANITY_STUDIO_GOOGLE_MAPS_API_KEY)
  }
  return ''
}

function loadMapsScript(apiKey) {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('No window'))
  }
  if (window.google?.maps?.places) {
    return Promise.resolve()
  }
  if (mapsScriptPromise) {
    return mapsScriptPromise
  }
  mapsScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.async = true
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Google Maps JavaScript API'))
    document.head.appendChild(s)
  })
  return mapsScriptPromise
}

function ManualPlaceIdField({value, onChange}) {
  return (
    <Stack space={2}>
      <Text size={1} muted>
        Paste manually
      </Text>
      <TextInput
        placeholder="ChIJ…"
        value={value || ''}
        onChange={(e) => {
          const v = e.currentTarget.value.trim()
          onChange(v ? set(v) : unset())
        }}
      />
    </Stack>
  )
}

export function PlaceIdGoogleInput(props) {
  const {onChange, value} = props
  const toast = useToast()
  const apiKey = getMapsApiKey()

  const [query, setQuery] = useState('')
  const [predictions, setPredictions] = useState([])
  const [ready, setReady] = useState(false)
  const [searchHint, setSearchHint] = useState('')
  const debounceRef = useRef(null)

  useEffect(() => {
    if (!apiKey) return undefined
    let cancelled = false
    loadMapsScript(apiKey)
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((e) => {
        toast.push({
          status: 'error',
          title: 'Could not load Google Maps',
          description: String(e?.message || e)
        })
      })
    return () => {
      cancelled = true
    }
  }, [apiKey, toast])

  const runPredictions = useCallback(
    (input) => {
      const trimmed = input.trim()
      if (!trimmed || !ready || !window.google?.maps?.places) {
        setPredictions([])
        setSearchHint('')
        return
      }
      const service = new window.google.maps.places.AutocompleteService()
      service.getPlacePredictions({input: trimmed}, (results, status) => {
        const OK = window.google.maps.places.PlacesServiceStatus.OK
        const ZERO = window.google.maps.places.PlacesServiceStatus.ZERO_RESULTS
        if (status === OK && results?.length) {
          setSearchHint('')
          setPredictions(results)
          return
        }
        setPredictions([])
        if (status === ZERO) {
          setSearchHint(
            trimmed.length >= 2 ? 'No matches — try a different search or paste a Place ID below.' : ''
          )
          return
        }
        setSearchHint('')
        if (status !== OK) {
          toast.push({
            status: 'warning',
            title: 'Places search failed',
            description: `${status}. Check the key: Maps JavaScript API + Places API enabled, HTTP referrer includes this Studio URL (e.g. http://localhost:3333/*).`
          })
        }
      })
    },
    [ready, toast]
  )

  useEffect(() => {
    if (!ready) return undefined
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      runPredictions(query)
    }, 280)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, ready, runPredictions])

  const pick = useCallback(
    (placeId, description) => {
      if (!placeId) return
      onChange(set(placeId))
      setQuery(description || '')
      setPredictions([])
      toast.push({status: 'success', title: 'Google Place ID saved'})
    },
    [onChange, toast]
  )

  const clear = useCallback(() => {
    onChange(unset())
    setQuery('')
    setPredictions([])
    toast.push({status: 'info', title: 'Google Place ID cleared'})
  }, [onChange, toast])

  if (!apiKey) {
    return (
      <Stack space={3}>
        <Text size={1} muted>
          Add <code>SANITY_STUDIO_GOOGLE_MAPS_API_KEY</code> to <code>studio/.env</code> (browser key:
          enable Maps JavaScript API + Places API; restrict by HTTP referrer:{' '}
          <code>http://localhost:3333/*</code> and your hosted Studio URL). Then restart{' '}
          <code>sanity dev</code>.
        </Text>
        <ManualPlaceIdField value={value} onChange={onChange} />
      </Stack>
    )
  }

  return (
    <Stack space={4}>
      <Stack space={2}>
        <TextInput
          placeholder="Search by name or address, then pick a result…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          disabled={!ready}
        />
        {!ready ? (
          <Text size={1} muted>
            Loading Google Places…
          </Text>
        ) : null}
        {ready && searchHint ? (
          <Text size={1} muted>
            {searchHint}
          </Text>
        ) : null}
        {predictions.length > 0 ? (
          <Box padding={2} style={{border: '1px solid var(--card-border-color)', borderRadius: 4}}>
            <Stack space={2}>
              {predictions.map((p) => (
                <Button
                  key={p.place_id}
                  mode="ghost"
                  padding={2}
                  style={{justifyContent: 'flex-start'}}
                  onClick={() => pick(p.place_id, p.description)}
                >
                  <Text size={1}>{p.description}</Text>
                </Button>
              ))}
            </Stack>
          </Box>
        ) : null}
      </Stack>

      {value ? (
        <Stack space={2}>
          <Text size={1}>
            Saved Place ID: <code>{value}</code>
          </Text>
          <Button mode="ghost" tone="critical" onClick={clear}>
            Clear Place ID
          </Button>
        </Stack>
      ) : null}

      <ManualPlaceIdField value={value} onChange={onChange} />
    </Stack>
  )
}
