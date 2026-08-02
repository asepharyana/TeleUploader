const stripPort = (host: string): string => {
  // Handle IPv6: [::1]:4321 -> [::1]
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    return host.slice(0, closeBracket + 1).toLowerCase();
  }
  return host.split(':')[0].toLowerCase().replace(/\.$/, '');
};

const isValidBucketLabel = (bucket: string): boolean =>
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
  !bucket.includes('..') &&
  !bucket.includes('.-') &&
  !bucket.includes('-.');

export const extractS3BucketFromHost = (host: string, domains: string[]): string | null => {
  const normalizedHost = stripPort(host);
  for (const domain of domains) {
    const normalizedDomain = stripPort(domain);
    if (!normalizedDomain || normalizedHost === normalizedDomain) continue;
    if (!normalizedHost.endsWith(`.${normalizedDomain}`)) continue;

    const bucket = normalizedHost.slice(0, -(normalizedDomain.length + 1));
    return isValidBucketLabel(bucket) ? bucket : null;
  }
  return null;
};
