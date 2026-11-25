import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../state/app';
import { docForPath, useDocsIndex } from '../lib/docs';
import { IconHelp } from './Icons';

/**
 * "Help" in a page header: opens the guide page whose `route` matches this page (or `slug`).
 * Renders nothing until the guide index has loaded, or when no page covers this one.
 */
export function HelpLink({ slug, label = 'Help', className = 'help-link' }: { slug?: string; label?: string; className?: string }) {
  const { api } = useApp();
  const loc = useLocation();
  const { docs } = useDocsIndex(api);
  const doc = slug ? docs?.find((d) => d.slug === slug) ?? null : docs ? docForPath(docs, loc.pathname) : null;
  if (slug && !doc && docs === null) {
    // a fixed target does not need the index; link straight away
    return <Link className={className} to={`/help/${slug}`}><IconHelp />{label}</Link>;
  }
  if (!doc) return null;
  return (
    <Link className={className} to={`/help/${doc.slug}`} title={`Help: ${doc.title}`} aria-label={`${label}: ${doc.title}`}>
      <IconHelp />{label}
    </Link>
  );
}
