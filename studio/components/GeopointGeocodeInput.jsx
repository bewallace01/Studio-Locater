import {Button, Stack, Text} from '@sanity/ui'
import {useToast} from '@sanity/ui'
import {useCallback, useState} from 'react'
import {set, useFormValue} from 'sanity'

const NOMINATIM_HEADERS = {
  'Accept-Language': 'en'
}

function formatAddressQuery(addr) {
  if (!addr || typeof addr !== 'object') return ''
  const line1 = addr.streetLine1 || ''
  const line2 = addr.streetLine2 && String(addr.streetLine2).trim() ? `, ${addr.streetLine2}` : ''
  const cityLine = [addr.city, addr.region].filter(Boolean).join(', ')
  const zipCountry = [addr.postalCode, addr.country].filter(Boolean).join(' ')
  const parts = []
  if (line1) parts.push(line1 + line2)
  if (cityLine) parts.push(cityLine)
  if (zipCountry) parts.push(zipCountry)
  return parts.join(', ').trim()
}

export function GeopointGeocodeInput(props) {
  const {renderDefault, onChange} = props
  const address = useFormValue(['address'])
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const geocode = useCallback(async () => {
    const q = formatAddressQuery(address)
    if (!q) {
      toast.push({status: 'error', title: 'Fill in address (at least street and city) first.'})
      return
    }
    setBusy(true)
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`
      const res = await fetch(url, {headers: NOMINATIM_HEADERS})
      const data = await res.json()
      if (!data || !data[0]) {
        toast.push({status: 'warning', title: 'No location found — try a fuller address.'})
        return
      }
      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        toast.push({status: 'warning', title: 'Invalid coordinates returned.'})
        return
      }
      onChange(set({lat, lng}))
      toast.push({status: 'success', title: 'Map location set from address.'})
    } catch (e) {
      toast.push({
        status: 'error',
        title: 'Geocoding failed (network or CORS).',
        description: String(e && e.message ? e.message : e)
      })
    } finally {
      setBusy(false)
    }
  }, [address, onChange, toast])

  return (
    <Stack space={3}>
      <Button onClick={geocode} disabled={busy} tone="primary" mode="ghost">
        {busy ? 'Looking up…' : 'Geocode address → map location'}
      </Button>
      <Text size={1} muted>
        Fills the pin from your address fields using OpenStreetMap Nominatim (free; be kind to their servers).
      </Text>
      {typeof renderDefault === 'function' ? renderDefault(props) : null}
    </Stack>
  )
}
