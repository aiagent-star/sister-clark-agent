export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  rating?: number;
  totalReviews?: number;
}

const PLACES_V1 = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount";

async function textSearch(
  query: string,
  apiKey: string,
  radiusMeters?: number
): Promise<PlaceResult[]> {
  const body: Record<string, unknown> = {
    textQuery: query,
    pageSize: 20,
  };

  if (radiusMeters !== undefined) {
    body.locationBias = {
      circle: {
        // radius only — no center coords needed when zip is in the query text
        radius: radiusMeters,
      },
    };
  }

  const res = await fetch(PLACES_V1, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Places (New) text search failed ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      nationalPhoneNumber?: string;
      websiteUri?: string;
      rating?: number;
      userRatingCount?: number;
    }>;
  };

  return (data.places ?? []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    phone: p.nationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    totalReviews: p.userRatingCount,
  }));
}

export async function searchChurches(
  city: string,
  state: string,
  denomination?: string,
  zipCode?: string
): Promise<PlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const location = zipCode ? `${zipCode} ${city} ${state}` : `${city} ${state}`;
  const radius = zipCode ? 5000 : undefined;

  const queries = denomination
    ? [`${denomination} churches in ${location}`]
    : [
        `churches in ${location}`,
        `Baptist churches in ${location}`,
        `Pentecostal churches in ${location}`,
        `Non-denominational churches in ${location}`,
      ];

  const resultSets = await Promise.all(
    queries.map((q) => textSearch(q, apiKey, radius))
  );

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

  return unique.slice(0, 20);
}
