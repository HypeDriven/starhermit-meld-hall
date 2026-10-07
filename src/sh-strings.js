'use strict';
(function (root) {
  // Localized strings for the StarHermit account controls (sign-in, invite,
  // toasts, player line) in the nine product locales.

  const en = {
    signIn: 'Sign in with StarHermit',
    invite: 'Invite a friend',
    copied: 'Invite link copied',
    copyFailed: 'Could not copy the invite link',
    signedOut: 'Signed out of StarHermit — progress keeps saving on this device',
    playingAs: 'Playing as {name}',
    lbPosting: 'Posting score to the leaderboard…',
    lbRank: 'Leaderboard rank: #{rank}',
    lbPosted: 'Score posted to the leaderboard.',
    lbNotPosted: 'Score not posted to the leaderboard.',
  };
  const es = {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    copied: 'Enlace de invitación copiado',
    copyFailed: 'No se ha podido copiar el enlace de invitación',
    signedOut: 'Se ha cerrado la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
    playingAs: 'Jugando como {name}',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'No se ha enviado la puntuación a la clasificación.',
  };
  const es419 = {
    ...es,
    copyFailed: 'No se pudo copiar el enlace de invitación',
    signedOut: 'Se cerró la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
    lbNotPosted: 'No se envió la puntuación a la clasificación.',
  };
  const fr = {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    copied: 'Lien d’invitation copié',
    copyFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil',
    playingAs: 'Vous jouez en tant que {name}',
    lbPosting: 'Envoi du score au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Score envoyé au classement.',
    lbNotPosted: 'Score non envoyé au classement.',
  };
  const frCA = {
    ...fr,
    signedOut: 'Déconnecté de StarHermit — la progression reste sauvegardée sur cet appareil',
    lbPosting: 'Envoi du pointage au classement…',
    lbPosted: 'Pointage envoyé au classement.',
    lbNotPosted: 'Pointage non envoyé au classement.',
  };

  const SH_STRINGS = {
    'en-US': en,
    'en-GB': en,
    'es-419': es419,
    'es-ES': es,
    'de-DE': {
      signIn: 'Mit StarHermit anmelden',
      invite: 'Freund einladen',
      copied: 'Einladungslink kopiert',
      copyFailed: 'Einladungslink konnte nicht kopiert werden',
      signedOut: 'Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert',
      playingAs: 'Angemeldet als {name}',
      lbPosting: 'Punktzahl wird an die Bestenliste gesendet …',
      lbRank: 'Platz in der Bestenliste: #{rank}',
      lbPosted: 'Punktzahl an die Bestenliste gesendet.',
      lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.',
    },
    'fr-FR': fr,
    'fr-CA': frCA,
    'pt-BR': {
      signIn: 'Entrar com StarHermit',
      invite: 'Convidar um amigo',
      copied: 'Link de convite copiado',
      copyFailed: 'Não foi possível copiar o link de convite',
      signedOut: 'Você saiu do StarHermit — o progresso continua salvo neste dispositivo',
      playingAs: 'Jogando como {name}',
      lbPosting: 'Enviando a pontuação para o ranking…',
      lbRank: 'Posição no ranking: #{rank}',
      lbPosted: 'Pontuação enviada para o ranking.',
      lbNotPosted: 'A pontuação não foi enviada para o ranking.',
    },
    'it-IT': {
      signIn: 'Accedi con StarHermit',
      invite: 'Invita un amico',
      copied: 'Link di invito copiato',
      copyFailed: 'Impossibile copiare il link di invito',
      signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo',
      playingAs: 'Giochi come {name}',
      lbPosting: 'Invio del punteggio alla classifica…',
      lbRank: 'Posizione in classifica: #{rank}',
      lbPosted: 'Punteggio inviato alla classifica.',
      lbNotPosted: 'Punteggio non inviato alla classifica.',
    },
  };

  /** Best locale for navigator.languages: exact tag, then regional rules, then en-US. */
  function shLocale(langs) {
    for (const raw of langs || []) {
      const tag = String(raw || '');
      const exact = Object.keys(SH_STRINGS).find((k) => k.toLowerCase() === tag.toLowerCase());
      if (exact) return exact;
      const lang = tag.split('-')[0].toLowerCase();
      if (lang === 'en') return /-(gb|uk|ie|au|nz)$/i.test(tag) ? 'en-GB' : 'en-US';
      if (lang === 'es') return /-es$/i.test(tag) ? 'es-ES' : 'es-419';
      if (lang === 'fr') return /-ca$/i.test(tag) ? 'fr-CA' : 'fr-FR';
      const def = { de: 'de-DE', pt: 'pt-BR', it: 'it-IT' }[lang];
      if (def) return def;
    }
    return 'en-US';
  }

  function shStrings(langs) {
    return SH_STRINGS[shLocale(langs)] || en;
  }

  const api = { SH_STRINGS: SH_STRINGS, shLocale: shLocale, shStrings: shStrings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ShStrings = api;
})(typeof self !== 'undefined' ? self : globalThis);
