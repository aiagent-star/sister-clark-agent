export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  rating?: number;
  totalReviews?: number;
}

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

async function textSearch(query: string, apiKey: string): Promise<PlaceResult[]> {
  const url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(query)}&type=church&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Places text search failed: ${res.status}`);

  const data = await res.json() as {
    status: string;
    results: Array<{
      place_id: string;
      name: string;
      formatted_address: string;
      rating?: number;
      user_ratings_total?: number;
    }>;
  };

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Google Places API error: ${data.status}`);
  }

  return (data.results ?? []).map((r) => ({
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address,
    rating: r.rating,
    totalReviews: r.user_ratings_total,
  }));
}

async function getPlaceDetails(placeId: string, apiKey: string): Promise<Partial<PlaceResult>> {
  const fields = "formatted_phone_number,website";
  const url = `${PLACES_BASE}/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return {};

  const data = await res.json() as {
    status: string;
    result?: { formatted_phone_number?: string; website?: string };
  };

  if (data.status !== "OK" || !data.result) return {};

  return {
    phone: data.result.formatted_phone_number,
    website: data.result.website,
  };
}

export async function searchChurches(
  city: string,
  state: string,
  denomination?: string
): Promise<PlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const queries = denomination
    ? [`${denomination} churches in ${city} ${state}`]
    : [
        `churches in ${city} ${state}`,
        `Baptist churches in ${city} ${state}`,
        `Pentecostal churches in ${city} ${state}`,
        `Non-denominational churches in ${city} ${state}`,
      ];

  // Run all queries in parallel
  const resultSets = await Promise.all(queries.map((q) => textSearch(q, apiKey)));

  // Deduplicate by placeId
  const seen = new Set<string>();
  const unique: PlaceResult[] = [];
  for (const results of resultSets) {
    for (const place of results) {
      if (!seen.has(place.placeId)) {
        seen.add(place.placeId);
        unique.push(place);
      }
    }
  }

  // Fetch phone/website details in parallel (cap at 20 to stay within budget)
  const capped = unique.slice(0, 20);
  const details = await Promise.all(capped.map((p) => getPlaceDetails(p.placeId, apiKey)));

  return capped.map((place, i) => ({ ...place, ...details[i] }));
}
