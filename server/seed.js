/* ============================================================
   SEED — parses the existing static HTML into server/data/content.json
   Run once (npm run seed) to rebuild content.json from the original
   static HTML kept in seed-source/. Warning: overwrites live content.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'seed-source');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const all = (re, s) => [...s.matchAll(re)];
const one = (re, s, group = 1, fallback = '') => {
  const m = s.match(re);
  return m ? m[group].trim() : fallback;
};

/* ---------- index.html ---------- */
const index = read('index.html');

const hero = {
  titleHtml: 'The world, <em>slowly</em>.',
  lead: one(/<p class="lead">([^<]+)<\/p>/, index),
  bgImage: one(/<div class="hero-bg"[^>]*>\s*<img src="([^"]+)"/, index),
  ctaPrimaryLabel: 'Browse destinations',
  ctaPrimaryHref: 'destinations.html',
  ctaSecondaryLabel: 'Plan a trip',
  ctaSecondaryHref: 'trip.html',
};

const DEST_TAGS = {
  ladakh: ['mountains-hills', 'deserts', 'adventure', 'lakes', 'road-trips'],
  andaman: ['islands', 'beach', 'water-sports', 'coral-reefs', 'honeymoon'],
  spiti: ['mountains-hills', 'spiritual', 'snow', 'adventure', 'trek'],
  manali: ['mountains-hills', 'hill-stations', 'snow', 'adventure', 'road-trips'],
  kerala: ['backwaters', 'lakes', 'honeymoon', 'wellness', 'wildlife'],
  meghalaya: ['waterfalls', 'hidden-gems', 'trek', 'adventure'],
  jaisalmer: ['deserts', 'heritage', 'forts-palaces'],
  goa: ['beach', 'water-sports', 'honeymoon'],
  coorg: ['hill-stations', 'tea-estates', 'wildlife', 'waterfalls'],
  sikkim: ['mountains-hills', 'snow', 'lakes', 'spiritual'],
  munnar: ['hill-stations', 'tea-estates', 'wellness', 'trek'],
  lakshadweep: ['islands', 'beach', 'coral-reefs', 'water-sports', 'honeymoon'],
};

/* Featured destinations (12 feat-cards) */
const destinations = all(
  /<article class="feat-card">\s*<a class="feat-media" href="destination-detail\.html\?d=([a-z]+)"[^>]*>\s*<img src="([^"]+)" alt="([^"]*)">\s*<\/a>\s*<div class="feat-info">\s*<div class="region">([^<]+)<\/div>\s*<h3 class="name">(.*?)<\/h3>\s*<div class="meta">\s*([\s\S]*?)\s*<\/div>\s*<div class="feat-actions">/g,
  index
).map((m) => {
  const metaSpans = all(/<span>([^<]*)<\/span>/g, m[6]).map((x) => x[1]);
  return {
    slug: m[1],
    image: m[2],
    region: m[4].trim(),
    name: m[5].trim(),
    season: metaSpans[0] || '',
    tagline: metaSpans[1] || '',
    featured: true,
    categories: DEST_TAGS[m[1]] || [],
  };
});

/* Travel highlights (12 float-cards) */
const highlights = all(
  /<a href="destination-detail\.html" class="float-card">\s*<img src="([^"]+)" alt="([^"]*)">\s*<div class="float-card-label">\s*<span class="day">([^<]*)<\/span>\s*<h3>([^<]+)<\/h3>\s*<span class="place">([^<]+)<\/span>/g,
  index
).map((m) => ({ image: m[1], kicker: m[3], title: m[4].trim(), place: m[5].trim() }));

/* Home ask-section */
const ask = {
  overline: 'Ask For Guidance',
  titleHtml: one(/class="ask-section"[\s\S]*?<h2>([\s\S]*?)<\/h2>/, index),
  body: one(/class="ask-section"[\s\S]*?<h2>[\s\S]*?<\/h2>\s*<p>([\s\S]*?)<\/p>/, index),
  email: one(/mailto:([^"]+)"/, index),
};

/* ---------- announcements.html (full list) ---------- */
const annHtml = read('announcements.html');
const announcements = all(
  /<a href="([^"]+)" class="ann-card" data-cat="([^"]+)"([^>]*)>\s*<div class="ann-head">\s*<span class="tag([^"]*)">([^<]+)<\/span>\s*<span class="ann-date">([^<]+)<\/span>\s*<\/div>\s*<h4>([\s\S]*?)<\/h4>\s*<p class="ann-excerpt">([\s\S]*?)<\/p>\s*<span class="ann-link">([\s\S]*?)<span/g,
  annHtml
).map((m) => ({
  href: m[1],
  category: m[2],
  external: /data-external/.test(m[3]),
  extProvider: one(/data-provider="([^"]+)"/, m[3]),
  extUrl: one(/data-url="([^"]+)"/, m[3]),
  tagClass: m[4].trim(),
  tagLabel: m[5].trim(),
  date: m[6].trim(),
  title: m[7].trim(),
  excerpt: m[8].trim(),
  linkLabel: m[9].trim(),
}));

/* ---------- packages.html (full list) ---------- */
const pkgHtml = read('packages.html');
const packages = all(
  /<article class="pkg-card">\s*<div class="thumb">\s*<img src="([^"]+)"[^>]*>\s*(?:<span class="tag([^"]*?) badge-pos">([^<]+)<\/span>\s*)?<\/div>\s*<div class="body">\s*<div class="pkg-region">([^<]+)<\/div>\s*<h3>([\s\S]*?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<div class="pkg-meta">\s*([\s\S]*?)\s*<\/div>\s*<div class="pkg-foot">\s*<div class="pkg-price"[^>]*>([\s\S]*?)<\/div>\s*<a href="([^"]*)"([^>]*)class="btn btn-sm[^"]*"([^>]*)>([\s\S]*?)<span/g,
  pkgHtml
).map((m) => {
  const priceRaw = m[8].trim();
  const attrs = (m[10] || '') + (m[11] || '');
  return {
    image: m[1],
    badgeClass: (m[2] || '').trim(),
    badgeLabel: (m[3] || '').trim(),
    region: m[4].trim(),
    title: m[5].trim(),
    description: m[6].trim(),
    metaSpans: all(/<span>([\s\S]*?)<\/span>/g, m[7]).map((x) => x[1].trim()),
    price: priceRaw.replace(/<small>[\s\S]*$/, '').trim(),
    priceUnit: one(/<small>([^<]*)<\/small>/, priceRaw),
    onRequest: !/<small>/.test(priceRaw),
    ctaHref: m[9],
    ctaExternal: /data-external/.test(attrs),
    ctaProvider: one(/data-provider="([^"]+)"/, attrs),
    ctaUrl: one(/data-url="([^"]+)"/, attrs),
    ctaLabel: m[12].trim(),
  };
});

/* ---------- blog.html ---------- */
const blogHtml = read('blog.html');
const blogFeature = {
  image: one(/<a class="blog-feature-main"[^>]*>\s*<img src="([^"]+)"/, blogHtml),
  category: one(/blog-feature-main[\s\S]*?<div class="category">([^<]+)<\/div>/, blogHtml),
  title: one(/blog-feature-main[\s\S]*?<h2>([\s\S]*?)<\/h2>/, blogHtml),
  byline: one(/blog-feature-main[\s\S]*?<div class="byline">([^<]+)<\/div>/, blogHtml),
};
const blogSide = all(
  /<a href="blog-post\.html" class="blog-feature-item">\s*<div class="thumb"><img src="([^"]+)"[^>]*><\/div>\s*<div>\s*<div class="category">([^<]+)<\/div>\s*<h4>([\s\S]*?)<\/h4>\s*<div class="meta">([^<]+)<\/div>/g,
  blogHtml
).map((m) => ({ image: m[1], category: m[2].trim(), title: m[3].trim(), meta: m[4].trim() }));
const blogPosts = all(
  /<a class="blog-card" href="blog-post\.html">\s*<div class="thumb"><img src="([^"]+)"[^>]*><\/div>\s*<div class="category">([^<]+)<\/div>\s*<h3>([\s\S]*?)<\/h3>\s*<p class="excerpt">([\s\S]*?)<\/p>\s*<div class="byline">([\s\S]*?)<\/div>/g,
  blogHtml
).map((m) => ({
  image: m[1],
  category: m[2].trim(),
  title: m[3].trim(),
  excerpt: m[4].trim(),
  bylineSpans: all(/<span>([\s\S]*?)<\/span>/g, m[5]).map((x) => x[1].trim()).filter((s) => s),
}));

/* ---------- gallery.html ---------- */
const galHtml = read('gallery.html');
const galleryItems = all(
  /<a data-lightbox(?: data-type="(video)")? data-src="([^"]+)" data-cat="([^"]+)" class="gallery-tile[^"]*">\s*<img src="([^"]+)" alt="([^"]*)">\s*(?:<div class="play-icon">[^<]*<\/div>\s*)?<div class="overlay"><span class="tag tag-plain">([^<]+)<\/span><\/div>/g,
  galHtml
).map((m) => ({
  type: m[1] || 'image',
  src: m[2],
  category: m[3],
  image: m[4],
  alt: m[5],
  label: m[6].trim(),
}));

/* ---------- picks.html ---------- */
const picksHtml = read('picks.html');
const picks = all(
  /<a href="([^"]+)" class="picks-row">\s*<div class="rank">([^<]+)<\/div>\s*<div class="thumb"><img src="([^"]+)"[^>]*><\/div>\s*<div class="info"><div class="region">([^<]+)<\/div><h3 class="name">([\s\S]*?)<\/h3><\/div>/g,
  picksHtml
).map((m) => ({ href: m[1], image: m[3], region: m[4].trim(), name: m[5].trim() }));


/* ---------- legal.html (8 documents from the inline switcher) ---------- */
const legalHtml = read('legal.html');
const legalDefaultBody = legalHtml
  .match(/<article class="legal-content" id="legal-content">([\s\S]*?)<\/article>/)[1]
  .replace(/<!--[\s\S]*?-->/, '').trim();
const legalObjLit = legalHtml.match(/const docs = (\{[\s\S]*?\});\s*const urlParams/)[1];
// trusted local file; eval resolves the template-literal bodies
// eslint-disable-next-line no-eval
const legalRaw = eval('(' + legalObjLit + ')');
const legalDocs = ['privacy', 'terms', 'usage', 'cookies', 'copyright', 'disclaimer', 'affiliate', 'faq']
  .map((slug) => {
    const d = legalRaw[slug];
    return {
      slug,
      navLabel: d.crumb,
      crumb: d.crumb,
      title: d.title,
      deck: d.deck,
      /* normalize inline links inside the body to clean URLs */
      body: (slug === 'privacy' ? legalDefaultBody : d.html.trim())
        .replace(/href="([a-z0-9-]+)\.html([?#][^"]*)?"/g,
          (m, p, rest) => (p === 'index' && !rest) ? 'href="/"' : `href="/${p}${rest || ''}"`),
      inFooter: slug !== 'faq',
    };
  });

/* ---------- page heroes ---------- */
const pageHero = (html) => ({
  titleHtml: one(/<section class="page-hero[^"]*">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/, html),
  lead: one(/<section class="page-hero[^"]*">[\s\S]*?<p class="lead"[^>]*>([\s\S]*?)<\/p>/, html),
});

packages.forEach((p, i) => { p.featured = i < 2; });
blogPosts.forEach((p, i) => { p.featured = i < 3; });
announcements.forEach((a, i) => { a.featured = i < 4; });

const content = {
  settings: {
    brandName: 'Triplipi',
    headerCtaLabel: 'Shop now',
    headerCtaHref: 'shop.html',
    contactEmail: 'hello@Triplipi.example',
    copyright: '© 2026 Triplipi. All rights reserved.',
    navLinks: [
      { label: 'Packages', href: 'packages.html' },
      { label: 'Gallery', href: 'gallery.html' },
      { label: 'Announcements', href: 'announcements.html' },
      { label: 'Blog', href: 'blog.html' },
      { label: 'Contact', href: 'contact.html' },
    ],
  },
  home: {
    hero,
    featuredHead: {
      overline: 'Featured Destinations',
      titleHtml: 'Twelve places that <em>belong on a list</em>.',
      blurb: one(/Featured Destinations[\s\S]*?<div>\s*<p>([\s\S]*?)<\/p>/, index),
    },
    highlightsHead: {
      overline: 'Travel Highlights',
      titleHtml: 'Twelve experiences <em>worth flying for</em>.',
    },
    announceHead: {
      overline: 'Latest Announcements',
      titleHtml: "What's <em>new</em> this week.",
    },
    blogHead: {
      overline: 'From the Blog',
      titleHtml: 'Stories from the <em>field</em>.',
    },
    packagesHead: {
      overline: 'Curated Packages',
      titleHtml: 'Trips <em>worth taking</em>, with partners we trust.',
    },
    ask,
  },
  destinations,
  destCategories: [
    { label: 'Mountains', slug: 'mountains-hills', image: 'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?w=400&q=80' },
    { label: 'Beaches', slug: 'beach', image: 'https://images.unsplash.com/photo-1561361513-2d000a50f0dc?w=400&q=80' },
    { label: 'Islands', slug: 'islands', image: 'https://images.unsplash.com/photo-1582510003544-4d00b7f74220?w=400&q=80' },
    { label: 'Waterfalls', slug: 'waterfalls', image: 'https://images.unsplash.com/photo-1571536802807-30451e3955d8?w=400&q=80' },
    { label: 'Heritage', slug: 'heritage', image: 'https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?w=400&q=80' },
    { label: 'Wildlife', slug: 'wildlife', image: 'https://images.unsplash.com/photo-1587474260584-136574528ed5?w=400&q=80' },
    { label: 'Spiritual', slug: 'spiritual', image: 'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=400&q=80' },
    { label: 'Hidden Gems', slug: 'hidden-gems', image: 'https://images.unsplash.com/photo-1605640840605-14ac1855827b?w=400&q=80' },
    { label: 'Water Sports', slug: 'water-sports', image: 'https://images.unsplash.com/photo-1599661046289-e31897846e41?w=400&q=80' },
    { label: 'Treks', slug: 'trek', image: 'https://images.unsplash.com/photo-1473625247510-8ceb1760943f?w=400&q=80' },
    { label: 'Deserts', slug: 'deserts', image: 'https://images.unsplash.com/photo-1502786129293-79981df4e689?w=400&q=80' },
    { label: 'Backwaters', slug: 'backwaters', image: 'https://images.unsplash.com/photo-1494791368093-85217fbbf8de?w=400&q=80' },
    { label: 'Hill Stations', slug: 'hill-stations', image: 'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?w=400&q=80' },
    { label: 'Lakes', slug: 'lakes', image: 'https://images.unsplash.com/photo-1561361513-2d000a50f0dc?w=400&q=80' },
    { label: 'Snow', slug: 'snow', image: 'https://images.unsplash.com/photo-1582510003544-4d00b7f74220?w=400&q=80' },
    { label: 'Adventure', slug: 'adventure', image: 'https://images.unsplash.com/photo-1571536802807-30451e3955d8?w=400&q=80' },
    { label: 'Pilgrimage', slug: 'pilgrimage', image: 'https://images.unsplash.com/photo-1602216056096-3b40cc0c9944?w=400&q=80' },
    { label: 'Honeymoon', slug: 'honeymoon', image: 'https://images.unsplash.com/photo-1587474260584-136574528ed5?w=400&q=80' },
    { label: 'Wellness', slug: 'wellness', image: 'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=400&q=80' },
    { label: 'National Parks', slug: 'national-parks', image: 'https://images.unsplash.com/photo-1605640840605-14ac1855827b?w=400&q=80' },
    { label: 'Forts & Palaces', slug: 'forts-palaces', image: 'https://images.unsplash.com/photo-1599661046289-e31897846e41?w=400&q=80' },
    { label: 'Road Trips', slug: 'road-trips', image: 'https://images.unsplash.com/photo-1473625247510-8ceb1760943f?w=400&q=80' },
    { label: 'Tea Estates', slug: 'tea-estates', image: 'https://images.unsplash.com/photo-1502786129293-79981df4e689?w=400&q=80' },
    { label: 'Coral Reefs', slug: 'coral-reefs', image: 'https://images.unsplash.com/photo-1494791368093-85217fbbf8de?w=400&q=80' },
  ],
  highlights,
  announcements,
  packages,
  blog: { feature: blogFeature, side: blogSide, posts: blogPosts },
  galleryItems,
  galleryCategories: [
    { label: 'Mountains', slug: 'mountains' },
    { label: 'Beaches', slug: 'beach' },
    { label: 'Heritage', slug: 'heritage' },
  ],
  picks,
  legalDocs,
  sponsored: [
    {
      title: 'Trans-Himalayan Expeditions — Ladakh circuits',
      kind: 'package',
      description: 'Two decades operating in the region. Female-led trip leaders, premium homestays, certified guides.',
      image: 'https://images.unsplash.com/photo-1571536802807-30451e3955d8?w=900&q=80',
      partner: 'Trans-Himalayan Expeditions',
      phone: '+91 98765 43210',
      callLabel: 'Call now',
      linkLabel: 'View packages',
      linkUrl: 'packages.html?d=ladakh',
      pages: ['gallery', 'packages', 'blog', 'destinations'],
    },
  ],
  pages: {
    destinations: pageHero(read('destinations.html')),
    packages: pageHero(pkgHtml),
    blog: pageHero(blogHtml),
    announcements: pageHero(annHtml),
    gallery: pageHero(galHtml),
    picks: pageHero(picksHtml),
    about: pageHero(read('about.html')),
    contact: pageHero(read('contact.html')),
  },
};

/* normalize internal links to clean URLs (no .html) */
const LINK = /^([a-z0-9-]+)\.html((\?|#).*)?$/;
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string') {
        const m = o[k].match(LINK);
        if (m) o[k] = (m[1] === 'index' && !m[2]) ? '/' : `/${m[1]}${m[2] || ''}`;
      } else walk(o[k]);
    }
  }
})(content);

fs.writeFileSync(
  path.join(__dirname, 'data', 'content.json'),
  JSON.stringify(content, null, 2)
);

/* report */
const counts = {
  destinations: destinations.length,
  highlights: highlights.length,
  announcements: announcements.length,
  packages: packages.length,
  blogPosts: blogPosts.length,
  blogSide: blogSide.length,
  galleryItems: galleryItems.length,
  picks: picks.length,
};
console.log('Seeded content.json:', JSON.stringify(counts, null, 2));
