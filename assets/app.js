/* Flamingo: подгружает актуальные данные студии (их меняет мастер через бота) и оживляет страницу. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = { bot: null, master: 'https://t.me/rstnpkh', categories: [], windows: [] };

  /* Данные сайта. На компьютере студии — живой сервер (/api/...). На GitHub Pages сервера нет:
     там лежат файлы data/*.json, которые программа студии обновляет сама, а своё время клиента
     проверяется по готовым диапазонам (бот всё равно перепроверит при записи). */
  var STATIC = /\.github\.io$/.test(location.hostname) || /[?&]static=1/.test(location.search);
  function getJSON(url, opts, ms) {
    // Таймаут, чтобы сайт не «зависал», если компьютер студии временно недоступен
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, ms || 12000);
    var o = opts || { cache: 'no-store' };
    if (ctrl) o.signal = ctrl.signal;
    var full = (o.method === 'POST') ? url : url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
    return fetch(full, o)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  /* Живой сервер студии. На GitHub Pages его адрес лежит в data/api.json (программа студии
     обновляет его сама); на компьютере студии сервер — тот же адрес, что и у страницы. */
  var liveBase = STATIC ? undefined : '';
  function apiBase(force) {
    if (!STATIC) return Promise.resolve('');
    if (liveBase && !force) return Promise.resolve(liveBase);
    return getJSON('/data/api.json', null, 8000)
      .then(function (d) { liveBase = d.api_url || null; return liveBase; })
      .catch(function () { liveBase = null; return null; });
  }
  function live(path, opts, retry) {
    return apiBase().then(function (base) {
      if (base === null) throw new Error('no live api');
      return getJSON(base + path, opts, 12000).catch(function (e) {
        if (!STATIC || retry === false) throw e;
        // адрес сервера мог смениться — берём свежий и пробуем ещё раз
        return apiBase(true).then(function (nb) {
          if (!nb) throw e;
          return getJSON(nb + path, opts, 12000);
        });
      });
    });
  }

  var staticSlots = null;
  var api = {
    config: function () {
      staticSlots = null;
      return getJSON(STATIC ? '/data/config.json' : '/api/config');
    },
    slots: function (serviceId) {
      var path = '/api/slots?service=' + encodeURIComponent(serviceId);
      if (!STATIC) return getJSON(path);
      // сначала живое расписание, если сервер студии недоступен — снимок с GitHub
      return live(path, null, false).catch(function () {
        staticSlots = staticSlots || getJSON('/data/slots.json');
        return staticSlots.then(function (all) {
          if (!all[serviceId]) throw new Error('no service');
          return all[serviceId];
        });
      });
    },
    book: function (payload) {
      // text/plain — чтобы браузер не делал лишний предварительный запрос к серверу
      return live('/api/book', { method: 'POST', cache: 'no-store', body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    },
    check: function (serviceId, date, time, slots) {
      var path = '/api/check?service=' + encodeURIComponent(serviceId) + '&date=' + date + '&time=' + encodeURIComponent(time);
      if (!STATIC) return getJSON(path);
      var self = this;
      return live(path, null, false).catch(function () { return self.checkLocal(serviceId, date, time, slots); });
    },
    checkLocal: function (serviceId, date, time, slots) {
      var day = (slots.days || []).filter(function (d) { return d.date === date; })[0];
      var parts = time.split(':');
      var m = +parts[0] * 60 + +parts[1];
      var hhmm = ('0' + parts[0]).slice(-2) + ':' + ('0' + parts[1]).slice(-2);
      var ok = day && (day.times.indexOf(hhmm) >= 0 || day.ok.some(function (r) { return r[0] <= m && m <= r[1]; }));
      var c = slots.custom;
      var reason = '';
      if (!ok) {
        var toMin = function (s) { var p = s.split(':'); return +p[0] * 60 + +p[1]; };
        if (m < toMin(c.start) || m > toMin(c.latest)) {
          reason = 'Мастер принимает с ' + c.start + ' до ' + c.end + ' — для этой услуги начать можно с ' + c.start + ' до ' + c.latest + '.';
        } else if (day && day.busy) {
          reason = 'Это время пересекается с другой записью (занято: ' + day.busy + ').';
        } else {
          reason = 'Это время недоступно — выберите другое.';
        }
      }
      return Promise.resolve({ ok: !!ok, time: hhmm, reason: reason });
    }
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function botLink(start) {
    if (state.bot) return state.bot + '?start=' + encodeURIComponent(start);
    return state.master; // бот ещё не подключён — ведём в личный Telegram мастера
  }

  function telHref(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    return d ? 'tel:+' + d : '#contacts';
  }

  function setExternal(a, href) {
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
  }

  /* ---------- данные студии ---------- */
  function applyOrg(org) {
    $$('[data-s]').forEach(function (n) {
      var key = n.getAttribute('data-s');
      if (!(key in org)) return;
      n.textContent = org[key];
      if (n.tagName === 'SMALL') n.hidden = !org[key];
    });
    $$('[data-s-at]').forEach(function (n) {
      var v = org[n.getAttribute('data-s-at')];
      n.textContent = v ? '@' + v.replace(/^@/, '') : '';
    });
    $$('[data-tel="phone"]').forEach(function (a) { a.href = telHref(org.phone); });

    if (org.phone2) {
      var p2 = el('a', { href: telHref(org.phone2) }, [el('b', { text: org.phone2 })]);
      $('#phones').appendChild(p2);
    }
    if (org.tg_username) {
      state.master = 'https://t.me/' + org.tg_username.replace(/^@/, '');
      setExternal($('#masterTg'), state.master);
    } else {
      $('#masterTg').hidden = true;
    }

    var q = encodeURIComponent(org.address);
    $('#mapLink').href = 'https://yandex.ru/maps/?text=' + q;
    $('#gisLink').href = 'https://2gis.ru/search/' + q;
    var frame = $('#mapFrame');
    var mapSrc = 'https://yandex.ru/map-widget/v1/?text=' + q + '&z=16';
    if (frame.getAttribute('src') !== mapSrc) frame.setAttribute('src', mapSrc);

    var socials = $('#socials');
    socials.textContent = '';
    [['instagram', 'Instagram'], ['vk', 'ВКонтакте'], ['tg_channel', 'Telegram-канал'], ['whatsapp', 'WhatsApp']]
      .forEach(function (pair) {
        var v = org[pair[0]];
        if (!v) return;
        var href = v;
        if (!/^https?:/.test(v)) {
          var h = v.replace(/^@/, '');
          href = pair[0] === 'instagram' ? 'https://instagram.com/' + h
            : pair[0] === 'vk' ? 'https://vk.com/' + h
            : pair[0] === 'tg_channel' ? 'https://t.me/' + h
            : 'https://wa.me/' + h.replace(/\D/g, '');
        }
        var a = el('a', { text: pair[1] });
        setExternal(a, href);
        socials.appendChild(a);
      });

    document.title = '«' + org.org_name + '» — ' + (org.tagline || 'студия красоты') + ' · ресницы и брови';
  }

  /* ---------- прайс ---------- */
  function renderPrices(categories) {
    var tabs = $('#priceTabs');
    var list = $('#priceList');
    tabs.textContent = '';
    if (!categories.length) {
      list.innerHTML = '';
      list.appendChild(el('p', { class: 'muted', text: 'Прайс скоро появится.' }));
      return;
    }
    function show(idx) {
      $$('.tab', tabs).forEach(function (t, i) { t.setAttribute('aria-selected', i === idx ? 'true' : 'false'); });
      list.textContent = '';
      categories[idx].services.forEach(function (s, i) {
        var isText = !/^\d[\d\s ]* ?₽$/.test(s.price_text);
        var book = el('a', { class: 'price-item__book', text: 'Записаться', href: '#' });
        book.addEventListener('click', function (e) { e.preventDefault(); openBooking({ service: s }); });
        var item = el('article', { class: 'price-item' }, [
          el('div', { class: 'price-item__name', text: s.name }),
          el('div', { class: 'price-item__price' }, [
            el('b', { class: isText ? 'is-text' : '', text: s.price_text }),
            book
          ]),
          el('div', { class: 'price-item__meta' }, [el('span', { text: '⏱ ' + s.duration_text })]),
          s.description ? el('p', { class: 'price-item__desc', text: s.description }) : null
        ]);
        item.style.animationDelay = (i * 40) + 'ms';
        list.appendChild(item);
      });
    }
    categories.forEach(function (c, i) {
      var b = el('button', { class: 'tab', type: 'button', role: 'tab', text: c.name });
      b.addEventListener('click', function () {
        show(i);
        b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      });
      tabs.appendChild(b);
    });
    show(0);
  }

  /* ---------- свободные окна ---------- */
  function renderWindows(windows) {
    var box = $('#windowsList');
    box.textContent = '';
    if (!windows.length) {
      var empty = el('div', { class: 'windows__empty' }, [
        el('p', { text: 'На ближайший месяц все окна заняты. Напишите в поддержку — постараемся найти для вас время.' })
      ]);
      box.appendChild(empty);
      return;
    }
    windows.forEach(function (w) {
      var d = new Date(w.date + 'T00:00:00');
      var parts = w.date_text.split(', ');
      var times = el('div', { class: 'day__times' });
      w.times.forEach(function (t) {
        var a = el('a', { class: 'slot', text: t, href: '#', 'aria-label': 'Записаться ' + w.date_text + ' на ' + t });
        a.addEventListener('click', function (e) { e.preventDefault(); openBooking({ date: w.date, time: t }); });
        times.appendChild(a);
      });
      box.appendChild(el('div', { class: 'day' }, [
        el('div', { class: 'day__date' }, [
          el('span', { class: 'day__num', text: String(d.getDate()) }),
          el('span', { class: 'day__label' }, [el('b', { text: parts[0] }), document.createTextNode((parts[1] || '').replace(/^\d+\s/, ''))])
        ]),
        times
      ]));
    });
  }

  /* ---------- онлайн-запись: услуга → дата и время → бот с готовыми данными ---------- */
  var booking = { service: null, date: null, time: null, days: [], cat: 0, req: 0 };

  function allServices() {
    return state.categories.reduce(function (acc, c) { return acc.concat(c.services); }, []);
  }

  function openBooking(opts) {
    booking.service = opts.service || null;
    booking.date = opts.date || null;
    booking.time = opts.time || null;
    if (!state.categories.length) { window.location.href = botLink('book'); return; }
    var sheet = $('#sheet');
    sheet.hidden = false;
    document.documentElement.classList.add('is-locked');
    requestAnimationFrame(function () { sheet.classList.add('is-open'); });
    if (booking.service) stepTime(); else stepService();
  }

  function closeBooking() {
    var sheet = $('#sheet');
    sheet.classList.remove('is-open');
    document.documentElement.classList.remove('is-locked');
    setTimeout(function () { sheet.hidden = true; }, 250);
  }

  function sheetSetup(title, showBack, backFn) {
    booking.backFn = backFn || stepService;
    $('#sheetTitle').textContent = title;
    $('#sheetBack').hidden = !showBack;
    $('#sheetBody').textContent = '';
    $('#sheetFoot').textContent = '';
    $('#sheetBody').scrollTop = 0;
  }

  function chosenWindowText() {
    if (!booking.date || !booking.time) return '';
    var w = (state.windows || []).filter(function (x) { return x.date === booking.date; })[0];
    return (w ? w.date_text : booking.date) + ', ' + booking.time;
  }

  function stepService() {
    sheetSetup('Выберите услугу', false);
    var body = $('#sheetBody');
    if (booking.date && booking.time) {
      body.appendChild(el('p', { class: 'sheet__note' }, [
        document.createTextNode('Выбранное окно: '), el('b', { text: chosenWindowText() })
      ]));
    }
    var tabs = el('div', { class: 'sheet__tabs', role: 'tablist' });
    var list = el('div', { class: 'svc-list' });
    function showCat(idx) {
      booking.cat = idx;
      $$('.tab', tabs).forEach(function (t, i) { t.setAttribute('aria-selected', i === idx ? 'true' : 'false'); });
      list.textContent = '';
      state.categories[idx].services.forEach(function (s) {
        var b = el('button', { type: 'button', class: 'svc-opt' }, [
          el('span', { class: 'svc-opt__name', text: s.name }),
          el('span', { class: 'svc-opt__meta', text: '⏱ ' + s.duration_text }),
          el('span', { class: 'svc-opt__price', text: s.price_text })
        ]);
        b.addEventListener('click', function () { booking.service = s; stepTime(); });
        list.appendChild(b);
      });
    }
    state.categories.forEach(function (c, i) {
      var t = el('button', { class: 'tab', type: 'button', role: 'tab', text: c.name });
      t.addEventListener('click', function () { showCat(i); t.scrollIntoView({ block: 'nearest', inline: 'center' }); });
      tabs.appendChild(t);
    });
    body.appendChild(tabs);
    body.appendChild(list);
    showCat(Math.min(booking.cat, state.categories.length - 1));

    var alt = el('a', { class: 'sheet__alt', text: 'Или выбрать всё в Telegram-боте →' });
    setExternal(alt, botLink('book'));
    $('#sheetFoot').appendChild(alt);
  }

  function stepTime() {
    var s = booking.service;
    sheetSetup('Дата и время', true);
    var body = $('#sheetBody');
    var change = el('button', { type: 'button', class: 'sheet__change', text: 'Изменить' });
    change.addEventListener('click', stepService);
    body.appendChild(el('div', { class: 'sheet__svc' }, [
      el('div', {}, [
        s.category ? el('small', { class: 'sheet__cat', text: s.category }) : null,
        el('b', { text: s.name }),
        el('small', { text: s.duration_text + ' · ' + s.price_text })
      ]),
      change
    ]));
    var area = el('div', { class: 'sheet__slots' }, [el('p', { class: 'muted', text: 'Загружаем свободное время…' })]);
    body.appendChild(area);

    var foot = $('#sheetFoot');
    var cta = el('button', { type: 'button', class: 'btn btn--primary btn--block btn--lg is-disabled', text: 'Выберите время' });
    var tg = el('a', { class: 'sheet__alt', text: 'или записаться через Telegram →' });
    foot.appendChild(cta);
    foot.appendChild(tg);

    function updateCta() {
      var ready = booking.date && booking.time;
      cta.classList.toggle('is-disabled', !ready);
      cta.disabled = !ready;
      cta.textContent = ready ? 'Записаться · ' + booking.time : 'Выберите время';
      tg.hidden = !ready;
      if (ready) {
        setExternal(tg, state.bot
          ? botLink('b' + s.id + '_' + booking.date.replace(/-/g, '') + '_' + booking.time.replace(':', ''))
          : state.master);
      }
    }
    cta.addEventListener('click', function () {
      if (booking.date && booking.time) stepForm();
    });
    tg.addEventListener('click', function () { setTimeout(closeBooking, 400); });

    var req = ++booking.req;
    api.slots(s.id)
      .then(function (data) {
        if (req !== booking.req) return;  // пользователь уже выбрал другую услугу
        booking.days = data.days || [];
        area.textContent = '';
        if (!booking.days.length) {
          area.appendChild(el('p', { class: 'sheet__note', text: 'Для этой услуги на ближайший месяц свободных окон нет 😔 Напишите в поддержку — постараемся помочь.' }));
          booking.date = booking.time = null;
          updateCta();
          return;
        }
        var day = booking.days.filter(function (d) { return d.date === booking.date; })[0];
        if (booking.time && (!day || (day.times.indexOf(booking.time) < 0 && !(data.custom && data.custom.enabled)))) {
          area.appendChild(el('p', { class: 'sheet__note sheet__note--warn', text: 'Выбранное окно не подходит для этой услуги по длительности — выберите другое время.' }));
          booking.time = null;
        }
        if (!day) { day = booking.days[0]; booking.date = day.date; }

        var dates = el('div', { class: 'date-row' });
        var times = el('div', { class: 'time-grid' });
        var custom = data.custom || { enabled: false };
        var own = el('div', { class: 'own-time', hidden: '' });

        function renderTimes() {
          times.textContent = '';
          own.textContent = '';
          own.hidden = true;
          var d = booking.days.filter(function (x) { return x.date === booking.date; })[0];
          function press(btnEl) {
            $$('.time-opt', times).forEach(function (x) { x.setAttribute('aria-pressed', String(x === btnEl)); });
          }
          d.times.forEach(function (t) {
            var b = el('button', { type: 'button', class: 'time-opt', text: t, 'aria-pressed': String(t === booking.time) });
            b.addEventListener('click', function () {
              booking.time = t;
              own.hidden = true;
              press(b);
              updateCta();
            });
            times.appendChild(b);
          });
          if (!custom.enabled) return;

          // Своё время: обычный выбор часов и минут (на iPhone и Android — системное «колесо»)
          var ownBtn = el('button', { type: 'button', class: 'time-opt time-opt--own', text: '✍️ Своё время', 'aria-pressed': 'false' });
          times.appendChild(ownBtn);
          var input = el('input', { type: 'time', class: 'own-time__input', min: custom.start, max: custom.latest, step: '300',
            'aria-label': 'Своё время начала' });
          var status = el('p', { class: 'own-time__status' });
          own.appendChild(el('p', { class: 'own-time__hint', text: 'Мастер принимает с ' + custom.start + ' до ' + custom.end +
            '. Для этой услуги начать можно до ' + custom.latest + '.' + (d.busy ? ' Уже занято: ' + d.busy + '.' : '') }));
          own.appendChild(input);
          own.appendChild(status);
          var check = 0;
          function validate() {
            var v = input.value;
            booking.time = null;
            updateCta();
            if (!v) { status.textContent = ''; return; }
            status.className = 'own-time__status';
            status.textContent = 'Проверяем…';
            var my = ++check;
            api.check(s.id, booking.date, v, data)
              .then(function (res) {
                if (my !== check) return;
                if (res.ok) {
                  booking.time = res.time;
                  status.className = 'own-time__status is-ok';
                  status.textContent = '✓ ' + res.time + ' свободно';
                } else {
                  status.className = 'own-time__status is-bad';
                  status.textContent = res.reason;
                }
                updateCta();
              })
              .catch(function () { status.textContent = 'Не удалось проверить время — попробуйте ещё раз.'; });
          }
          input.addEventListener('change', validate);
          input.addEventListener('input', validate);
          function openOwn() {
            press(ownBtn);
            booking.time = null;
            own.hidden = false;
            updateCta();
            if (input.value) validate();
          }
          ownBtn.addEventListener('click', openOwn);
          // Время не из списка (например, выбранное раньше) — сразу показываем поле
          if (booking.time && d.times.indexOf(booking.time) < 0) { input.value = booking.time; openOwn(); }
          if (!d.times.length) {
            times.insertBefore(el('p', { class: 'own-time__hint', text: 'Готового времени на этот день нет — укажите своё.' }), ownBtn);
            openOwn();
          }
        }
        booking.days.forEach(function (d) {
          var dd = new Date(d.date + 'T00:00:00');
          var parts = d.date_text.split(', ');
          var chip = el('button', { type: 'button', class: 'date-chip', 'aria-pressed': String(d.date === booking.date) }, [
            el('small', { text: parts[0] }),
            el('b', { text: String(dd.getDate()) }),
            el('small', { text: (parts[1] || '').replace(/^\d+\s/, '').slice(0, 3) })
          ]);
          chip.addEventListener('click', function () {
            if (booking.date !== d.date) booking.time = null;
            booking.date = d.date;
            $$('.date-chip', dates).forEach(function (x) { x.setAttribute('aria-pressed', String(x === chip)); });
            renderTimes();
            updateCta();
          });
          dates.appendChild(chip);
        });
        area.appendChild(el('p', { class: 'sheet__label', text: 'Дата' }));
        area.appendChild(dates);
        area.appendChild(el('p', { class: 'sheet__label', text: 'Время' }));
        area.appendChild(times);
        area.appendChild(own);
        renderTimes();
        updateCta();
        var active = $('.date-chip[aria-pressed="true"]', dates);
        if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
      })
      .catch(function () {
        if (req !== booking.req) return;
        area.textContent = '';
        var a = el('a', { class: 'btn btn--ghost btn--block', text: 'Выбрать время в Telegram-боте' });
        setExternal(a, botLink('svc_' + s.id));
        area.appendChild(el('p', { class: 'sheet__note', text: 'Не удалось загрузить расписание.' }));
        area.appendChild(a);
      });
    updateCta();
  }

  /* ---------- запись прямо на сайте: имя и телефон ---------- */
  function savedClient() {
    try { return JSON.parse(localStorage.getItem('flamingo_client') || '{}'); } catch (e) { return {}; }
  }

  function stepForm() {
    var s = booking.service;
    var w = (booking.days || []).filter(function (d) { return d.date === booking.date; })[0];
    var when = (w ? w.date_text : booking.date) + ', ' + booking.time;
    sheetSetup('Ваши данные', true, stepTime);
    var body = $('#sheetBody');
    var change = el('button', { type: 'button', class: 'sheet__change', text: 'Изменить' });
    change.addEventListener('click', stepTime);
    body.appendChild(el('div', { class: 'sheet__svc' }, [
      el('div', {}, [
        s.category ? el('small', { class: 'sheet__cat', text: s.category }) : null,
        el('b', { text: s.name }),
        el('small', { text: '📅 ' + when + ' · ' + s.price_text })
      ]),
      change
    ]));
    var saved = savedClient();
    var name = el('input', { type: 'text', class: 'field__input', name: 'name', autocomplete: 'name', maxlength: '60',
      placeholder: 'Как к вам обращаться', required: '' });
    var phone = el('input', { type: 'tel', class: 'field__input', name: 'phone', autocomplete: 'tel', inputmode: 'tel',
      maxlength: '20', placeholder: '+7 900 123-45-67', required: '' });
    name.value = saved.name || '';
    phone.value = saved.phone || '';
    var trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'field__trap',
      'aria-hidden': 'true' });
    var consent = el('input', { type: 'checkbox', id: 'consent' });
    var error = el('p', { class: 'sheet__note sheet__note--warn', hidden: '' });
    body.appendChild(el('div', { class: 'sheet__form' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Имя' }), name]),
      el('label', { class: 'field' }, [el('span', { text: 'Телефон' }), phone]),
      trap,
      el('label', { class: 'consent', for: 'consent' }, [consent, el('span', { text: 'Согласен(на) на обработку персональных данных для записи' })]),
      error
    ]));

    var foot = $('#sheetFoot');
    var submit = el('button', { type: 'button', class: 'btn btn--primary btn--block btn--lg', text: 'Записаться · ' + booking.time });
    var tg = el('a', { class: 'sheet__alt', text: 'или записаться через Telegram →' });
    setExternal(tg, state.bot ? botLink('b' + s.id + '_' + booking.date.replace(/-/g, '') + '_' + booking.time.replace(':', '')) : state.master);
    foot.appendChild(submit);
    foot.appendChild(tg);

    function showError(text, field) {
      error.textContent = text;
      error.hidden = false;
      if (field === 'name') name.focus();
      if (field === 'phone') phone.focus();
    }
    submit.addEventListener('click', function () {
      error.hidden = true;
      if (name.value.trim().length < 2) return showError('Напишите, пожалуйста, ваше имя.', 'name');
      if (phone.value.replace(/\D/g, '').length < 10) return showError('Проверьте номер телефона — например, +7 900 123-45-67.', 'phone');
      if (!consent.checked) return showError('Отметьте согласие на обработку персональных данных.');
      submit.disabled = true;
      submit.classList.add('is-disabled');
      submit.textContent = 'Записываем…';
      try { localStorage.setItem('flamingo_client', JSON.stringify({ name: name.value.trim(), phone: phone.value.trim() })); } catch (e) {}
      api.book({ service_id: s.id, date: booking.date, time: booking.time, name: name.value, phone: phone.value,
        consent: true, website: trap.value })
        .then(function (res) {
          if (res.ok) return stepDone(res);
          submit.disabled = false;
          submit.classList.remove('is-disabled');
          submit.textContent = 'Записаться · ' + booking.time;
          showError(res.reason, res.field);
          if (res.taken) {
            var again = el('button', { type: 'button', class: 'btn btn--ghost btn--block', text: 'Выбрать другое время' });
            again.addEventListener('click', function () { booking.time = null; stepTime(); });
            error.after(again);
          }
        })
        .catch(function () {
          submit.disabled = false;
          submit.classList.remove('is-disabled');
          submit.textContent = 'Попробовать ещё раз';
          showError('Не удалось связаться со студией. Попробуйте ещё раз через минуту или запишитесь через Telegram — ссылка ниже.');
        });
    });
  }

  function stepDone(res) {
    var b = res.booking;
    sheetSetup('Вы записаны!', false);
    var body = $('#sheetBody');
    body.appendChild(el('div', { class: 'done' }, [
      el('div', { class: 'done__icon', text: '🎉' }),
      el('p', { class: 'done__title', text: b.date_text + ' в ' + b.time }),
      el('p', { text: b.service + ' · ' + b.duration + ' · ' + b.price }),
      el('p', { class: 'muted', text: '📍 ' + res.address }),
      res.payment ? el('p', { class: 'muted', text: '💵 ' + res.payment }) : null,
      el('p', { class: 'muted', text: 'Если планы изменятся — позвоните: ' + res.phone })
    ]));
    var foot = $('#sheetFoot');
    if (res.telegram) {
      var tg = el('a', { class: 'btn btn--primary btn--block', text: '🔔 Получить напоминание в Telegram' });
      setExternal(tg, res.telegram);
      foot.appendChild(tg);
      foot.appendChild(el('p', { class: 'sheet__hint', text: 'Бот пришлёт напоминание накануне, там же можно перенести запись.' }));
    }
    var ok = el('button', { type: 'button', class: 'btn btn--ghost btn--block', text: 'Готово' });
    ok.addEventListener('click', closeBooking);
    foot.appendChild(ok);
    load();  // обновляем свободные окна на странице
  }

  /* ---------- галерея ---------- */
  function renderGallery(images) {
    var section = $('#gallery');
    var grid = $('#galleryGrid');
    grid.textContent = '';
    section.hidden = !images.length;
    images.forEach(function (src) {
      var b = el('button', { type: 'button', 'aria-label': 'Открыть фото' }, [el('img', { src: src, alt: 'Работа мастера', loading: 'lazy' })]);
      b.addEventListener('click', function () { openLightbox(src); });
      grid.appendChild(b);
    });
    observeReveal($$('.reveal', section));
  }

  function openLightbox(src) {
    var lb = $('#lightbox');
    $('img', lb).src = src;
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    $('#lightbox').hidden = true;
    document.body.style.overflow = '';
  }

  function applyLinks() {
    $$('[data-book]').forEach(function (a) { setExternal(a, botLink('book')); });
    setExternal($('#supportBot'), state.bot ? botLink('support') : state.master);
  }

  function load() {
    return api.config()
      .then(function (data) {
        state.bot = data.bot_url;
        state.categories = data.categories || [];
        state.windows = data.windows || [];
        applyOrg(data.org);
        applyLinks();
        renderPrices(data.categories || []);
        renderWindows(data.windows || []);
        renderGallery(data.gallery || []);
        if (data.next_free) {
          $('#heroSlotText').textContent = data.next_free.date_text + ', ' + data.next_free.time;
          $('#heroSlot').hidden = false;
        } else {
          $('#heroSlot').hidden = true;
        }
      })
      .catch(function () {
        applyLinks();
        $('#priceList').textContent = '';
        $('#priceList').appendChild(el('p', { class: 'muted', text: 'Не удалось загрузить прайс. Обновите страницу или напишите нам в Telegram.' }));
        $('#windowsList').textContent = '';
        $('#windowsList').appendChild(el('p', { class: 'muted', text: 'Свободные окна можно посмотреть в нашем Telegram-боте.' }));
      });
  }

  /* ---------- интерфейс ---------- */
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) : null;

  function observeReveal(nodes) {
    nodes.forEach(function (n, i) {
      if (!io) { n.classList.add('is-in'); return; }
      n.style.transitionDelay = (i % 4) * 70 + 'ms';
      io.observe(n);
    });
  }

  function initNav() {
    var burger = $('#burger');
    var nav = $('#nav');
    function setOpen(open) {
      nav.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      document.body.style.overflow = open ? 'hidden' : '';
    }
    burger.addEventListener('click', function () { setOpen(!nav.classList.contains('is-open')); });
    $$('a', nav).forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    window.addEventListener('resize', function () { if (window.innerWidth > 900) setOpen(false); });

    var header = $('#header');
    var bar = $('#mobileBar');
    var hero = $('.hero');
    function onScroll() {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      header.classList.toggle('is-scrolled', y > 8);
      var heroEnd = hero.offsetTop + hero.offsetHeight - 120;
      var nearFooter = (window.innerHeight + y) > (document.body.scrollHeight - 140);
      bar.classList.toggle('is-visible', y > heroEnd && !nearFooter);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#year').textContent = new Date().getFullYear();
    initNav();
    observeReveal($$('.reveal'));
    applyLinks();
    load();
    // Окна и прайс могут поменяться, пока страница открыта, — обновляем раз в 2 минуты.
    setInterval(load, 120000);

    // Любая кнопка «Записаться» открывает выбор услуги и времени прямо на сайте.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-book]');
      if (!a || !state.categories.length) return;
      e.preventDefault();
      openBooking({});
    });
    $$('#sheet [data-close]').forEach(function (b) { b.addEventListener('click', closeBooking); });
    $('#sheetBack').addEventListener('click', function () { (booking.backFn || stepService)(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeBooking(); });

    var lb = $('#lightbox');
    lb.addEventListener('click', function (e) { if (e.target === lb || e.target.closest('.lightbox__close')) closeLightbox(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLightbox(); });
  });
})();
