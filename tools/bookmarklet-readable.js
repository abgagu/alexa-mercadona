// Versión legible del bookmarklet. La versión "minificada" para pegar en la
// barra de marcadores está en tools/bookmarklet.txt.
//
// Uso:
//   1. Crea un marcador nuevo en Chrome.
//   2. Nombre: "Mercadona token".
//   3. URL: pega el contenido completo de bookmarklet.txt (empieza por javascript:).
//   4. Estando logueado en https://tienda.mercadona.es/ pulsa el marcador.
//   5. Te copia al portapapeles el JSON con bearer y customerUuid listo para pegar en secrets.json.
(async () => {
	try {
		const raw = localStorage.getItem("MO-user");
		if (!raw) {
			alert("No estás logueado en Mercadona o no se encuentra MO-user en localStorage. Abre primero https://tienda.mercadona.es/ y haz login.");
			return;
		}
		const u = JSON.parse(raw);
		if (!u.token || !u.uuid) {
			alert("MO-user existe pero no contiene token/uuid. Estructura inesperada.");
			return;
		}
		const out = JSON.stringify({ bearer: u.token, customerUuid: u.uuid }, null, "\t");
		await navigator.clipboard.writeText(out);
		alert("secrets.json copiado al portapapeles. Pégalo en el editor de Alexa (Code -> secrets.json) y Deploy.");
	} catch (e) {
		alert("Error: " + (e && e.message ? e.message : e));
	}
})();
