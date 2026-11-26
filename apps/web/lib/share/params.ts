/** A share id: 24 random lowercase letters and digits (about 124 bits), minted by the site. */
export const SHARE_ID_RE = /^[a-z0-9]{24}$/;

export const validShareId = (id: string): boolean => SHARE_ID_RE.test(id);
