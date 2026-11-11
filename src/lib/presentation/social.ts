import {
  DEFAULT_SOCIAL_IMAGE_ALT,
  DEFAULT_SOCIAL_IMAGE_PATH,
} from './constants.ts';
import { publicAssetUrl } from './urls.ts';

export type SocialImageMetadata = {
  url: string;
  alt: string;
};

export function buildSocialImageMetadata(
  socialImage = DEFAULT_SOCIAL_IMAGE_PATH,
  socialImageAlt = DEFAULT_SOCIAL_IMAGE_ALT,
): SocialImageMetadata {
  return {
    url: publicAssetUrl(socialImage),
    alt: socialImageAlt,
  };
}
