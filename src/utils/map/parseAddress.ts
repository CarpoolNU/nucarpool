import { CarpoolFeature } from "../types";

export function parseMapboxFeature(feature: any): CarpoolFeature {
  let street = "";
  let city = "";
  let state = "";
  let buildingNumber = "";

  // extract from the main text field for street
  street = feature.text || "";

  // extract city and state from context array
  if (feature.context) {
    for (const context of feature.context) {
      // look for place (city)
      if (context.id.startsWith("place") && !city) {
        city = context.text;
      }
      // look for region (state)
      else if (context.id.startsWith("region") && !state) {
        state = context.text;
      }
      // check for neighborhood as fallback for city
      else if (context.id.startsWith("neighborhood") && !city) {
        city = context.text;
      }
      // check for locality as another fallback for city
      else if (context.id.startsWith("locality") && !city) {
        city = context.text;
      }
    }
  }

  // extract building number if present in street
  if (street && !buildingNumber) {
    const addressParts = street.split(" ");
    if (addressParts.length > 0 && !isNaN(Number(addressParts[0]))) {
      buildingNumber = addressParts[0];
      street = addressParts.slice(1).join(" ");
    }
  }

  // append building number if we found one
  if (buildingNumber && street) {
    street = `${buildingNumber} ${street}`;
  }

  // if we still don't have city/state, try to parse from place_name
  if ((!city || !state) && feature.place_name) {
    const addressParts = feature.place_name.split(",");
    if (addressParts.length >= 2) {
      if (!city) {
        // part before the first comma is usually street/city combo
        // part after first comma is usually city/state
        const secondPart = addressParts[1]?.trim();
        if (secondPart && !secondPart.match(/\d/)) {
          // if no numbers, likely a city
          city = secondPart;
        }
      }
      if (!state) {
        // last part is usually state/zip/country
        const lastPart = addressParts[addressParts.length - 1]?.trim();
        if (lastPart) {
          // extract state (usually 2 words or less)
          const stateParts = lastPart
            .split(" ")
            .filter((part: string) => !part.match(/\d/)); // Remove zip code
          state = stateParts.slice(0, 2).join(" ");
        }
      }
    }
  }

  return {
    id: feature.id,
    place_name: feature.place_name,
    center: feature.center,
    street: street || "",
    city: city || "",
    state: state || "",
    geometry: feature.geometry,
    properties: feature.properties,
    type: feature.type,
  };
}
