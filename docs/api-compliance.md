# Third-party API compliance (Yelp & Google Maps / Places)

This project can **query** Yelp and display results **live** in the map. **Do not** copy Yelp’s full business payloads into Sanity (or any database) for more than **24 hours** without following Yelp’s rules below.

Always read the **current** legal documents on the provider’s site before you ship.

---

## Yelp (Fusion / Places API)

**Primary documents**

- [API Terms of Use](https://terms.yelp.com/developers/api_terms/)
- [Display Requirements](https://terms.yelp.com/developers/display_requirements)

**Practices relevant to this repo**

| Topic | Policy summary (non-legal) |
|--------|----------------------------|
| **Caching / storage** | Display Requirements state you **must not store data longer than 24 hours** (with narrow exceptions such as storing business IDs for back-end matching—see Yelp’s terms for exact wording). **Do not** bulk-import Yelp search results into Sanity as long-lived documents. |
| **Attribution** | Show that listing/rating content came from Yelp (logo/attribution, link to Yelp or the business page where required). Don’t blend Yelp star ratings with ratings from other sources in a single “combined” score. |
| **How we use it** | The Express server calls Yelp **when the user searches**; responses are **not** written to Sanity. Optional: short-lived server cache ≤ 24h if you add one later. |

**Questions:** [api@yelp.com](mailto:api@yelp.com)

---

## Google Maps Platform (Places API, etc.)

**Primary documents**

- [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)

**Practices relevant to “storing” data**

- **Place IDs** are called out as **exempt** from general caching restrictions and may be **stored indefinitely** for re-fetching details (see Places policies and [Place ID](https://developers.google.com/maps/documentation/places/web-service/place-id) docs).
- **Other** Places fields are subject to the broader Maps Platform terms (including caching limits for many content types). Read the **Service Specific Terms** for your APIs.
- **Attribution:** follow [Google Maps attribution requirements](https://developers.google.com/maps/documentation/places/web-service/policies) (e.g. “Google Maps” / logo when showing their content).

**This repo** does not call Google Places by default; if you add it, wire attribution and field usage to these policies.

---

## Sanity CMS

Sanity is **your** editorial store. It is appropriate for:

- Studios you **create or import** with rights to use the data.
- Optional **Google Place IDs** (only if your Google contract allows the use you intend).

It is **not** appropriate for long-term storage of **full Yelp API payloads** without complying with Yelp’s storage and display rules above.

---

## Disclaimer

This file is **not** legal advice. Have counsel review your product if you rely on third-party listings at scale.
