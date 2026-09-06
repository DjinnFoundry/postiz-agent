# Puesta en marcha por producto

Revisión del 6 de septiembre de 2026. El código se ha reforzado para la primera operación; el envío completo a cuentas reales aún requiere configuración y comprobación en las redes.

## Correcciones principales

- Publicadores, cachés, temas, archivos temporales, alertas y YouTube usan el tenant seleccionado. Un tenant inexistente o una configuración corrupta provocan un error visible.
- Contrato Postiz corregido: ruta self-hosted, campos de cuentas, ajustes de cada plataforma, respuesta de creación y programación.
- Duplicados: exclusión de procesos simultáneos, historial archivado, dry-run sin publicaciones ficticias y reintentos solo de plataformas pendientes.
- Instagram: continuación desde la parte pendiente, guardado inmediato, duración máxima y separación de al menos cinco minutos entre fechas aceptadas.
- Texto, imágenes y vídeos preparados conservan el mensaje y los enlaces del producto, sin promoción automática de AudioKids. Imágenes y vídeos no pasan por Whisper. Los textos de producto demasiado largos se rechazan en lugar de recortarse silenciosamente.
- Render: salida de la introducción corregida y HyperFrames fijado en 0.8.30; la actualización del motor requiere una comprobación local antes de cambiar esa versión.
- Operación: JSON limpio, daemon que refleja fallos y despierta al detenerlo, candidatos corruptos omitidos con aviso, pruebas aisladas y CI con compilación y tests.

## Configurar cada producto

Esta versión se mantiene en la rama `mainline`. Clona con `git clone --branch mainline https://github.com/DjinnFoundry/postiz-agent.git`. Instala Node 22 o posterior. Ejecuta `pnpm install --frozen-lockfile`, `pnpm build` y `node dist/cli.js init`. Un tenant usa `tenants/<producto>/config.json`:

```json
{
  "postiz": {
    "apiUrl": "https://social.example.com/api/public/v1",
    "apiKey": "SUSTITUIR_POR_LA_CLAVE",
    "integrationIds": {
      "x": "ID_CUENTA_PRODUCTO_X",
      "instagram": "ID_CUENTA_PRODUCTO_INSTAGRAM"
    }
  },
  "brand": {
    "name": "Mi producto",
    "defaultHashtags": ["miproducto"],
    "ctas": {
      "instagram": [{ "id": "web", "text": "Descúbrelo en el enlace de la bio." }]
    }
  }
}
```

Obtén los IDs con `node dist/cli.js integrations --tenant <producto> --json`. Si hay varias cuentas activas de una red, `integrationIds` evita elegir otra marca. `postiz.platformSettings` admite ajustes por plataforma, como privacidad y declaraciones comerciales o de contenido generado con IA. Revísalos antes de usar TikTok: por defecto se envía directamente con visibilidad pública.

Para AudioKids añade `audiokids.outputDir`. Para YouTube configura `youtubecli.path` y, si corresponde, `youtubecli.channelId`. Sus subidas siguen siendo **no listadas**. Los campos omitidos pueden heredarse del `.env` general: especifica las credenciales y cuentas de producción por producto.

## Preparar y comprobar contenido

Guarda este bundle en `tmp/producto-post.json`. Usa un ID único, válido como nombre de archivo:

```json
{
  "id": "producto-lanzamiento-2026-09-06",
  "kind": "text",
  "locale": "es",
  "text": {
    "body": "Ya está disponible nuestra nueva función. Descúbrela en https://example.com."
  }
}
```

`text` se admite en X. Para una imagen usa `kind: "image-post"` y `primaryMedia` con la ruta absoluta; YouTube requiere vídeo y se rechaza antes de subir una imagen. Para un vídeo preparado usa `kind: "video"`. `audio-story` genera diapositivas y requiere una transcripción válida; los flags para omitir subtítulos no implementan un modo de diapositivas sin palabras.

```sh
node dist/cli.js copy preview --tenant <producto> --bundle-file ./tmp/producto-post.json --platform x --json
node dist/cli.js publish --tenant <producto> --bundle-file ./tmp/producto-post.json --platforms x --dry-run --json
```

El preview no sube contenido ni escribe decisiones de publicación. Los renders van a una carpeta única bajo `tmp/`; consulta las rutas en el informe.

Completa [el despliegue](../deploy/README.md), verifica las cuentas con `integrations` y revisa `doctor`. Tras aprobar el contenido, ejecuta el mismo `publish` sin `--dry-run` para **una sola red**. Comprueba la cola de Postiz y la cuenta de destino. Un ID de Postiz confirma aceptación, no publicación final. Activa cron después de comprobar ese ciclo.

`dispatch` recorre AudioKids; los productos de otros orígenes usan `publish --bundle-file`. Un contenido publicado hace más de 30 días puede volver a ser elegible: retíralo del directorio de entrada si no quieres republicarlo. Spotify se gestiona con `rss` y subida del feed. La bandeja de mensajes sigue usando datos simulados.

## Recuperación sin duplicados

`reconcile-post` significa que el servidor puede haber aceptado el contenido antes de perder la respuesta. El agente bloquea ese contenido/plataforma incluso tras rotar el historial. Comprueba primero la cola y la cuenta. Si existe, conserva el bloqueo hasta registrar el resultado comprobado. Solo si confirmas que no se creó, restablece los intentos. `--platform x` limita el reset a X; omitirlo restablece todas las plataformas del mismo ID:

```sh
node dist/cli.js decisions --tenant <producto> --stuck --json
node dist/cli.js decisions --tenant <producto> --slug <id> --pretty
node dist/cli.js decisions --tenant <producto> --reset-attempts <id> --platform x
```

Un proceso interrumpido puede dejar `data/<producto>/decisions.jsonl.publish.lock` (directamente en `data/` para default). Contiene PID y hora. Comprueba que el proceso terminó y reconcilia los envíos antes de retirarlo. No uses `--force` como recuperación automática. Conserva las partes completadas y todos los archivos de decisiones al restaurar backups.

## Configuración que requiere el operador

- Crear el administrador local, obtener su clave API de Postiz y guardarla en `.env` o en cada tenant. La clave existente no autentica contra una instancia recién creada.
- Configurar las aplicaciones y conectar las cuentas OAuth de cada red. Los ejemplos de credenciales están vacíos a propósito.
- Elegir el dominio HTTPS público y registrar los callbacks que muestre Postiz. Las redes deben poder recuperar los archivos publicados.
- Comprobar una publicación real en una sola cuenta antes de activar un scheduler. Un dry-run y los tests no prueban permisos ni aceptación final de la red.

El entorno local de esta revisión ya usa `localhost:4007/api/public/v1`. Se corrigió la URL antigua, se generó la contraseña de base de datos que faltaba y los archivos `.env` se restringieron a permisos `0600`. Esos valores son privados y no se suben al repositorio. El stack de seis servicios arrancó saludable; la UI redirige a autenticación y la API devuelve `401` sin credenciales válidas.

YouTubeCLI ya no tiene conflictos en el estado comprobado. Su compilación y 34 pruebas acotadas de contrato, registro, publicación simulada, reconciliación y arranque pasan. El adaptador coincide con ese contrato, pero las cuentas de YouTube requieren su propia autenticación.

Fuentes: [creación de posts](https://docs.postiz.com/public-api/posts/create), [integraciones](https://docs.postiz.com/public-api/integrations/list), [TikTok](https://docs.postiz.com/public-api/providers/tiktok) y [Compose](https://docs.postiz.com/installation/docker-compose).

## Verificación local

Compilación TypeScript y suite completa verificadas. Las publicaciones recientes o inciertas se detienen antes de ejecutar preflight o Whisper; el reset por plataforma conserva los bloqueos de otras redes. `pnpm audit` no detecta vulnerabilidades conocidas en el lockfile revisado. También se ha generado y examinado un MP4 real de 13,5 segundos, 1080 × 1920, con vídeo H.264 y audio AAC, usando audio sintético y marcas de palabras controladas. Esa prueba cubre plantilla, lint, render y validación del archivo; no verifica Whisper ni las cuentas externas.
