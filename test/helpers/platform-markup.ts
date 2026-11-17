// Markup builders that mirror test/fixtures/<platform>/*.html, for posts a test inserts or recycles at run time.

const attr = (name: string, value: string | null): string => (value === null ? '' : ` ${name}="${value.replaceAll('&', '&amp;')}"`);

export type MarkupPost = { id: string; author: string; src: string | null };

export function redditImagePost(o: MarkupPost & { sub?: string; slug?: string }): string {
  const sub = o.sub ?? 'pf_memes';
  const slug = o.slug ?? `synthetic_post_${o.id}`;
  const permalink = `/r/${sub}/comments/${o.id}/${slug}/`;
  const srcset = o.src === null ? null : `${o.src} 640w`;
  return `
<article class="w-full m-0" aria-label="Synthetic post ${o.id}">
  <shreddit-post id="t3_${o.id}" permalink="${permalink}" view-context="AggregateFeed" post-type="image" domain="i.redd.it"
    author="${o.author}" author-id="t2_${o.author}" subreddit-prefixed-name="r/${sub}" subreddit-name="${sub}" post-title="Synthetic post ${o.id}">
    <a slot="full-post-link" class="absolute inset-0" href="https://www.reddit.com${permalink}" target="_self">Synthetic post ${o.id}</a>
    <span slot="credit-bar" class="flex">
      <span slot="authorName" class="flex">
        <a aria-label="Author: u/${o.author}" href="https://www.reddit.com/user/${o.author}/">
          <img class="h-full w-full" src="https://styles.redditmedia.com/t5_pf/styles/profileIcon_${o.author}.png" alt="u/${o.author} avatar" style="width: 24px; height: 24px" />
          ${o.author}
        </a>
      </span>
    </span>
    <a slot="title" href="${permalink}">Synthetic post ${o.id}</a>
    <div slot="post-media-container" class="block w-full">
      <div class="relative overflow-hidden">
        <div id="t3_${o.id}-aspect-ratio" data-aspect-ratio-container="">
          <div class="absolute inset-0 h-full">
            <shreddit-media-lightbox-listener class="contents" post-id="t3_${o.id}" permalink="${permalink}">
              <div class="media-lightbox-img h-full w-full">
                <img alt="" role="presentation" class="absolute top-1/2 -translate-y-1/2" loading="lazy"${attr('src', o.src)}${attr('srcset', srcset)} style="width: 654px; height: 648px" />
                <img data-post-media-primary="" alt="r/${sub} - Synthetic post ${o.id}" class="i18n-post-media-img preview-img non-lightboxed-content" loading="lazy"${attr('src', o.src)}${attr('srcset', srcset)} style="width: 545px; height: 540px" />
                <div class="lightboxed-content hidden">
                  <zoomable-img class="flex w-full h-full"><img class="z-1 max-h-full max-w-full" alt="" loading="lazy" src="https://i.redd.it/${o.id}.png" /></zoomable-img>
                </div>
              </div>
            </shreddit-media-lightbox-listener>
          </div>
        </div>
      </div>
    </div>
  </shreddit-post>
</article>`;
}

export function wykopImageEntry(o: MarkupPost): string {
  const srcset = o.src === null ? null : `${o.src.replace(',w400', ',w800')} 2x`;
  return `
<section data-level="1" id="thread-${o.id}" class="thread visible">
  <div class="line"><span></span></div>
  <section class="item">
    <button class="toggle">Rozwin/Zwin</button>
    <header>
      <a href="/ludzie/${o.author}" class="avatar active" style="width: 27px; height: 27px;">
        <figure class="male burgundy-profile"><img src="https://wykop.pl/cdn/c0834752/avatar-${o.author},q60.jpg" alt="" style="width: 27px; height: 27px" /></figure>
        <span>${o.author}</span>
      </a>
      <div>
        <div>
          <a href="/ludzie/${o.author}" class="username burgundy-profile active"><span>${o.author}</span></a>
          <a href="/wpis/${o.id}/synthetic-entry-${o.id}" target="_blank" class="date"><time datetime="2026-11-17 10:00:00" class="date">1 godz.</time></a>
        </div>
      </div>
    </header>
    <div data-thread-item-selectable="${o.id}" class="content">
      <div><section class="entry-content"><div class="wrapper">Synthetic entry ${o.id}</div></section></div>
    </div>
    <div class="media">
      <section class="multimedia">
        <div class="photos photos-1">
          <figure class="cover"><img${attr('src', o.src)}${attr('srcset', srcset)} alt="" style="aspect-ratio: 4 / 3; width: 400px; height: 300px" /></figure>
        </div>
      </section>
      <div class="gallery"></div>
    </div>
    <footer><button class="comments">0</button></footer>
  </section>
</section>`;
}

export function xPhotoTweet(o: MarkupPost): string {
  const srcset = o.src === null ? null : o.src.replace('name=small', 'name=large');
  return `
<div data-testid="cellInnerDiv" style="transform: translateY(0px); position: absolute; width: 100%;">
  <div class="css-175oi2r">
    <article aria-labelledby="id__${o.id}" role="article" tabindex="0" class="css-175oi2r" data-testid="tweet">
      <div class="css-175oi2r">
        <div data-testid="Tweet-User-Avatar">
          <div data-testid="UserAvatar-Container-${o.author}">
            <a href="/${o.author}" role="link"><img alt="" draggable="true" src="https://pbs.twimg.com/profile_images/1/${o.author}_normal.jpg" style="width: 40px; height: 40px" /></a>
          </div>
        </div>
        <div data-testid="User-Name">
          <div><a href="/${o.author}" role="link"><span>Synthetic ${o.author}</span></a></div>
          <div>
            <a href="/${o.author}" role="link" tabindex="-1"><span>@${o.author}</span></a>
            <span>·</span>
            <a href="/${o.author}/status/${o.id}" dir="ltr" aria-label="Nov 17" role="link"><time datetime="2026-11-17T10:00:00.000Z">Nov 17</time></a>
          </div>
        </div>
        <div data-testid="tweetText" lang="en"><span>Synthetic tweet ${o.id}</span></div>
        <div aria-labelledby="id__${o.id}_media">
          <a href="/${o.author}/status/${o.id}/photo/1" role="link">
            <div aria-label="Image" data-testid="tweetPhoto">
              <div style="background-image: url(&quot;${o.src ?? ''}&quot;);"></div>
              <img alt="Image" draggable="true"${attr('src', o.src)}${attr('srcset', srcset === null ? null : `${srcset} 2x`)} style="width: 506px; height: 380px" />
            </div>
          </a>
        </div>
      </div>
    </article>
  </div>
</div>`;
}
