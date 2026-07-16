export const BROWSER_HOME_URL = "https://www.google.com/";

const localHostPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const ipAddressPattern = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

export function toBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) return BROWSER_HOME_URL;

  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // A missing scheme is handled below; everything else becomes a search.
  }

  if (localHostPattern.test(value) || ipAddressPattern.test(value)) {
    return new URL(`http://${value}`).toString();
  }
  if (domainPattern.test(value)) return new URL(`https://${value}`).toString();

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
