/// <reference path="./manga-provider.d.ts" />

/**
 * MangaMoins + Anime-Sama (repli)
 *
 * MangaMoins (https://mangamoins.com) sort les chapitres en cours très vite,
 * mais n'a pas tout l'historique des séries. Pour chaque œuvre, on prend tous
 * les chapitres MangaMoins et on complète les numéros manquants (anciens
 * chapitres, séries absentes de MangaMoins) avec Anime-Sama.
 *
 * Identifiants :
 *   œuvre    : "mm=<slugMangaMoins>|as=<slugAnimeSama>|t=<titre encodé>" (mm ou as peut être vide)
 *   chapitre : "mm|<slugChapitre>|<nbPages>|<baseUrl>"
 *              "as|<titre œuvre AS encodé>|<numéro>|<nbPages>"
 */
class Provider {
    mm = 'https://mangamoins.com';
    as = 'https://anime-sama.to';
    asScans = 'https://anime-sama.to/s2/scans';
    ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // ---------------------------------------------------------------- utils

    headers(referer) {
        return {
            'User-Agent': this.ua,
            'Referer': referer,
            'Accept-Language': 'fr-FR,fr;q=0.9',
        };
    }

    decodeHtml(s) {
        return (s || '')
            .replace(/&#0*39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
            .replace(/&amp;/g, '&')
            .trim();
    }

    norm(s) {
        return this.decodeHtml(s)
            .toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]/g, '');
    }

    sameTitle(a, bList) {
        const na = this.norm(a);
        return !!na && bList.some(b => this.norm(b) === na);
    }

    encodeId(mm, as, title) {
        return `mm=${mm || ''}|as=${as || ''}|t=${encodeURIComponent(title || '')}`;
    }

    decodeId(id) {
        // Tolère aussi un slug nu (considéré comme MangaMoins).
        if (!id.includes('mm=')) return { mm: id, as: '', title: '' };
        const out = { mm: '', as: '', title: '' };
        for (const part of id.split('|')) {
            const [k, ...rest] = part.split('=');
            const v = rest.join('=');
            if (k === 'mm') out.mm = v;
            else if (k === 'as') out.as = v;
            else if (k === 't') out.title = decodeURIComponent(v);
        }
        return out;
    }

    // L'API MangaMoins refuse (403) toute requête sans le cookie "mm_session",
    // délivré par la page d'accueil et lié à l'IP + User-Agent (valable 2 h).
    mmCookie = '';
    mmCookieAt = 0;

    readCookie(res, name) {
        if (res.cookies && res.cookies[name]) return res.cookies[name]; // Seanime
        let raw = [];
        if (res.headers && typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie(); // Node
        else if (res.rawHeaders && res.rawHeaders['Set-Cookie']) raw = res.rawHeaders['Set-Cookie'];
        for (const line of raw) {
            const m = String(line).match(new RegExp(`(?:^|\\s)${name}=([^;]+)`));
            if (m) return m[1];
        }
        return '';
    }

    async mmSession(force) {
        if (!force && this.mmCookie && Date.now() - this.mmCookieAt < 90 * 60 * 1000) return this.mmCookie;
        try {
            const res = await fetch(`${this.mm}/`, { headers: this.headers(`${this.mm}/`) });
            const value = this.readCookie(res, 'mm_session');
            if (value) {
                this.mmCookie = `mm_session=${value}`;
                this.mmCookieAt = Date.now();
            }
        } catch (e) {
            // sans cookie, l'API renverra 403
        }
        return this.mmCookie;
    }

    async mmJson(url, referer) {
        for (const force of [false, true]) {
            const cookie = await this.mmSession(force);
            const res = await fetch(url, {
                headers: { ...this.headers(referer), 'Accept': 'application/json', 'Cookie': cookie },
            });
            if (res.status === 403 && !force) continue; // cookie expiré : on en redemande un
            if (!res.ok) return null;
            try {
                return await res.json();
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    async getJson(url, referer) {
        const res = await fetch(url, { headers: { ...this.headers(referer), 'Accept': 'application/json' } });
        if (!res.ok) return null;
        try {
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------- MangaMoins API

    async mmSearch(query) {
        const seen = new Map();
        for (let page = 1; page <= 2; page++) {
            const data = await this.mmJson(
                `${this.mm}/api/v1/mangas?q=${encodeURIComponent(query)}&page=${page}`,
                `${this.mm}/`,
            );
            const items = data?.data || [];
            for (const it of items) {
                if (!it.mangaSlug || seen.has(it.mangaSlug)) continue;
                seen.set(it.mangaSlug, {
                    slug: it.mangaSlug,
                    title: this.decodeHtml(it.title),
                    image: it.cover,
                });
            }
            if (!data || page * (data.limit || 10) >= (data.total || 0)) break;
        }
        return Array.from(seen.values());
    }

    async mmChapters(slug) {
        const data = await this.mmJson(
            `${this.mm}/api/v1/manga?manga=${encodeURIComponent(slug)}`,
            `${this.mm}/`,
        );
        if (!data?.chapters) return { title: '', chapters: [] };
        return {
            title: this.decodeHtml(data.info?.title),
            chapters: data.chapters.map(c => ({
                id: `mm|${c.slug}`,
                url: `${this.mm}/scan/${c.slug}`,
                title: c.title ? `Chapitre ${c.num} : ${this.decodeHtml(c.title)}` : `Chapitre ${c.num}`,
                chapter: String(c.num),
                scanlator: 'MangaMoins',
                language: 'fr',
                updatedAt: c.time ? new Date(c.time * 1000).toISOString() : undefined,
            })),
        };
    }

    async mmPages(chapterSlug) {
        const referer = `${this.mm}/scan/${chapterSlug}`;
        const data = await this.mmJson(`${this.mm}/api/v1/scan?slug=${encodeURIComponent(chapterSlug)}`, referer);
        if (!data?.pagesBaseUrl || !data.pageNumbers) return [];

        let base = data.pagesBaseUrl;
        if (!base.endsWith('/')) base += '/';
        const count = parseInt(data.pageNumbers, 10) || 0;

        // Les pages sont "01.webp", "02.webp"... ; on vérifie l'extension sur la page 1.
        let ext = 'webp';
        for (const candidate of ['webp', 'png', 'jpg', 'jpeg']) {
            try {
                const res = await fetch(`${base}01.${candidate}`, { method: 'HEAD', headers: this.headers(referer) });
                if (res.ok) {
                    ext = candidate;
                    break;
                }
            } catch (e) {
                // on essaie l'extension suivante
            }
        }

        return Array.from({ length: count }, (_, i) => ({
            url: `${base}${String(i + 1).padStart(2, '0')}.${ext}`,
            index: i,
            headers: { 'Referer': `${this.mm}/` },
        }));
    }

    // ------------------------------------------------------- Anime-Sama

    async asSearch(query) {
        try {
            const res = await fetch(`${this.as}/catalogue/?search=${encodeURIComponent(query)}`, {
                headers: this.headers(`${this.as}/`),
            });
            if (!res.ok) return [];
            const html = await res.text();
            const results = [];
            const cardRegex = /<div[^>]*class=["'][^"']*catalog-card[^"']*["'][^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
            for (const m of html.matchAll(cardRegex)) {
                const card = m[1];
                const href = card.match(/href=["'](?:https?:\/\/[^/"']*)?\/catalogue\/([^/"']+)\/?["']/);
                if (!href) continue;
                const types = card.match(/<p[^>]*class=["'][^"']*info-value[^"']*["'][^>]*>([^<]*)<\/p>/);
                if (!types || !/scans/i.test(types[1])) continue;
                const title = card.match(/<h2[^>]*class=["'][^"']*card-title[^"']*["'][^>]*>([^<]*)<\/h2>/);
                const alt = card.match(/<p[^>]*class=["'][^"']*alternate-titles[^"']*["'][^>]*>([^<]*)<\/p>/);
                const img = card.match(/<img[^>]+src=["']([^"']+)["']/);
                const synonyms = alt && alt[1].trim()
                    ? alt[1].split(',').map(s => this.decodeHtml(s)).filter(Boolean)
                    : [];
                results.push({
                    slug: href[1],
                    title: title ? this.decodeHtml(title[1]) : href[1],
                    synonyms,
                    image: img?.[1],
                });
            }
            return results;
        } catch (e) {
            return [];
        }
    }

    async asChapters(slug) {
        try {
            const catalogueUrl = `${this.as}/catalogue/${slug}`;
            const res = await fetch(catalogueUrl, { headers: this.headers(`${this.as}/`) });
            if (!res.ok) return [];
            const html = await res.text();

            // Panneaux de scans déclarés via panneauScan("Scans", "scan/vf") ; on ignore la VA.
            const panels = Array.from(html.matchAll(/panneauScan\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g))
                .map(m => m[2].trim())
                .filter(p => !p.includes('va'));
            // Priorité : noir et blanc (même version que MangaMoins), puis le panneau
            // principal "scan/vf", puis le reste (spin-off...).
            const rank = p => (/noir/i.test(p) ? 0 : p.startsWith('scan/') ? 1 : 2);
            panels.sort((a, b) => rank(a) - rank(b));
            if (!panels.length) return [];

            const main = panels[0];
            const sub = await fetch(`${this.as}/catalogue/${slug}/${main}/`, { headers: this.headers(catalogueUrl) });
            if (!sub.ok) return [];
            const subHtml = await sub.text();
            const oeuvre = subHtml.match(/<[^>]*id=["']titreOeuvre["'][^>]*>([^<]*)/i)?.[1] ?? '';
            if (!oeuvre.trim()) return [];

            const counts = await this.getJson(
                `${this.asScans}/get_nb_chap_et_img.php?oeuvre=${encodeURIComponent(oeuvre)}`,
                `${this.as}/`,
            );
            if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return [];

            // Les clés de l'API sont des positions (dossiers 1..N), pas des numéros de chapitre :
            // la page déclare les chapitres spéciaux (One Shot, 262.5...) qui décalent la suite.
            const total = Object.keys(counts).length;
            const labels = this.asChapterLabels(subHtml, total);

            return Object.entries(counts).map(([pos, pages]) => {
                const label = labels[parseInt(pos, 10) - 1] || { num: parseFloat(pos), name: `Chapitre ${pos}` };
                return {
                    id: `as|${encodeURIComponent(oeuvre)}|${pos}|${pages}`,
                    url: `${this.as}/catalogue/${slug}/${main}/`,
                    title: label.name,
                    chapter: String(label.num),
                    scanlator: 'Anime-Sama',
                    language: 'fr',
                };
            });
        } catch (e) {
            return [];
        }
    }

    /**
     * Reconstitue la liste affichée par Anime-Sama à partir des appels du type :
     *   resetListe(); creerListe(1, 1045); newSP("One Shot"); finirListe(1046);
     * Retourne, pour chaque position (0-based), { num, name }. Un spécial non numérique
     * reçoit le numéro du chapitre précédent + 0.5 (ex. One Shot après 1045 → 1045.5).
     */
    asChapterLabels(html, total) {
        const script = html
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const calls = Array.from(script.matchAll(/\b(resetListe|creerListe|newSPF?|finirListe)\s*\(([^)]*)\)/g))
            .map(m => ({ fn: m[1], args: m[2].split(',').map(a => a.trim().replace(/^["']|["']$/g, '')) }));

        const lastReset = calls.map(c => c.fn).lastIndexOf('resetListe');
        const list = lastReset >= 0 ? calls.slice(lastReset + 1) : [];
        if (!list.length) {
            return Array.from({ length: total }, (_, i) => ({ num: i + 1, name: `Chapitre ${i + 1}` }));
        }

        const specials = list.filter(c => c.fn === 'newSP' || c.fn === 'newSPF').length;
        const used = new Set();
        const labels = [];
        let prev = 0;
        let prevWasNamedSpecial = false;
        const round = n => Math.round(n * 100) / 100;
        const pushNum = n => {
            labels.push({ num: n, name: `Chapitre ${n}` });
            used.add(n);
            prev = n;
            prevWasNamedSpecial = false;
        };

        for (const c of list) {
            if (c.fn === 'creerListe' || c.fn === 'finirListe') {
                // Math.ceil : tolère les fautes de frappe du site, ex. finirListe(24.5)
                const start = Math.ceil(parseFloat(c.args[0]));
                const end = c.fn === 'creerListe' ? parseInt(c.args[1], 10) : total - specials;
                if (isNaN(start) || isNaN(end)) continue;
                for (let i = start; i <= end; i++) if (!used.has(i)) pushNum(i);
            } else {
                const raw = c.args[0] || '';
                const asNum = parseFloat(raw);
                if (c.fn === 'newSP' && /^\d+(\.\d+)?$/.test(raw) && !used.has(asNum)) {
                    // Spécial numéroté : chapitre 0, 262.5, 22.1...
                    pushNum(asNum);
                } else {
                    // Spécial nommé (One Shot, AE 1, Volume 3...) : placé juste après le
                    // chapitre précédent, sans jamais atteindre le numéro entier suivant.
                    let n = round(prevWasNamedSpecial ? prev + 0.01 : Math.floor(prev) + 0.5);
                    while (used.has(n)) n = round(n + 0.01);
                    used.add(n);
                    prev = n;
                    prevWasNamedSpecial = true;
                    labels.push({ num: n, name: c.fn === 'newSPF' ? raw : `Chapitre ${raw}` });
                }
            }
        }

        // La liste déclarée par le site ne colle pas toujours au nombre réel de dossiers :
        // on tronque, ou on complète avec les numéros suivants.
        labels.length = Math.min(labels.length, total);
        while (labels.length < total) {
            let n = Math.floor(prev) + 1;
            while (used.has(n)) n++;
            pushNum(n);
        }
        return labels;
    }

    asPages(encodedOeuvre, num, pageCount) {
        const count = parseInt(pageCount, 10) || 0;
        return Array.from({ length: count }, (_, i) => ({
            url: `${this.asScans}/${encodedOeuvre}/${num}/${i + 1}.jpg`,
            index: i,
            headers: { 'Referer': `${this.as}/` },
        }));
    }

    // ------------------------------------------------------- MangaProvider

    async search(opts) {
        const [mmResults, asResults] = await Promise.all([
            this.mmSearch(opts.query).catch(() => []),
            this.asSearch(opts.query).catch(() => []),
        ]);

        const usedAs = new Set();
        const results = [];

        for (const m of mmResults) {
            const pair = asResults.find(a => !usedAs.has(a.slug) && this.sameTitle(m.title, [a.title, ...a.synonyms]));
            if (pair) usedAs.add(pair.slug);
            results.push({
                id: this.encodeId(m.slug, pair?.slug, m.title),
                title: m.title,
                synonyms: pair ? [pair.title, ...pair.synonyms].filter(t => t !== m.title) : undefined,
                image: m.image || pair?.image,
            });
        }

        for (const a of asResults) {
            if (usedAs.has(a.slug)) continue;
            results.push({
                id: this.encodeId('', a.slug, a.title),
                title: a.title,
                synonyms: a.synonyms.length ? a.synonyms : undefined,
                image: a.image,
            });
        }

        // Titres identiques à la recherche en tête, puis ceux qui la contiennent.
        const score = r => {
            const titles = [r.title, ...(r.synonyms || [])];
            if (this.sameTitle(opts.query, titles)) return 0;
            const q = this.norm(opts.query);
            if (titles.some(t => this.norm(t).includes(q))) return 1;
            return 2;
        };
        return results
            .map((r, i) => ({ r, i, s: score(r) }))
            .sort((a, b) => a.s - b.s || a.i - b.i)
            .map(x => x.r);
    }

    async findChapters(id) {
        let { mm, as, title } = this.decodeId(id);

        // Complète le côté manquant en cherchant l'œuvre par son titre.
        if (title && !mm) {
            const found = (await this.mmSearch(title).catch(() => [])).find(m => this.sameTitle(m.title, [title]));
            if (found) mm = found.slug;
        }
        if (title && !as) {
            const found = (await this.asSearch(title).catch(() => []))
                .find(a => this.sameTitle(title, [a.title, ...a.synonyms]));
            if (found) as = found.slug;
        }

        const [mmData, asList] = await Promise.all([
            mm ? this.mmChapters(mm).catch(() => ({ chapters: [] })) : { chapters: [] },
            as ? this.asChapters(as).catch(() => []) : [],
        ]);

        // MangaMoins d'abord ; Anime-Sama seulement pour les numéros absents.
        const byNum = new Map();
        for (const c of mmData.chapters) byNum.set(parseFloat(c.chapter), c);
        for (const c of asList) {
            const n = parseFloat(c.chapter);
            if (!isNaN(n) && !byNum.has(n)) byNum.set(n, c);
        }

        const chapters = Array.from(byNum.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, c], index) => ({ ...c, index }));

        return chapters;
    }

    async findChapterPages(id) {
        const parts = id.split('|');
        if (parts[0] === 'mm') return this.mmPages(parts[1]);
        if (parts[0] === 'as') return this.asPages(parts[1], parts[2], parts[3]);
        return [];
    }
}
