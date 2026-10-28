# Manhunt Tracker

Web para jugar al manhunt con el móvil: reloj de ronda, mapa con la ubicación de los corredores cada cierto tiempo (ping) y registro de capturas. Cuando pillan a un corredor, pasa a ser cazador hasta que acabe la ronda.

## Cómo funciona una partida

1. Una persona entra, escribe su nombre y pulsa **Crear partida nueva**. Es el anfitrión.
2. Le pasa el código de 5 letras (o el enlace con **Copiar enlace**) a los demás, que se unen con él.
3. El anfitrión elige la zona: **Elegir centro en el mapa** (y toca el mapa) o **Usar mi posición**. La zona es un círculo con el radio que pongas (800 m por defecto). Fuera del círculo el mapa sale oscurecido.
4. Ajusta duración, ventaja, cada cuántos minutos hay ping (5 por defecto) y cuántos cazadores hay, y pulsa **Empezar ronda**. Los equipos se sortean al azar en ese momento. También puede pulsar **Sortear equipos** antes para verlos.
5. Al acabar la ventaja, el móvil de cada corredor manda su posición al mapa cada vez que toca ping. Todos los móviles hacen el ping a la vez.
6. Si alguien sale de la zona, su móvil pita cada 4 segundos hasta que vuelve, vibra (solo en Android) y muestra un aviso en rojo con los metros que le faltan para volver. Queda apuntado en el registro y, si es un corredor, su punto en el mapa pone "fuera de zona".
7. Cuando pillan a alguien, cualquiera pulsa **Pillado** (o el propio corredor, **Me han pillado**) y elige quién lo pilló. Ese corredor se pasa a cazadores y deja de salir en el mapa.
8. Si pillan a todos, ganan los cazadores. Si se acaba el tiempo, ganan los corredores. En la ronda siguiente se sortean los equipos otra vez.

**Antes de empezar,** que todos pulsen **Probar alarma** debajo del mapa. Así comprueban que se oye y el móvil deja sonar la alarma luego (los móviles no dejan sonar nada hasta que tocas la pantalla).

**Importante:** los corredores tienen que tener la web abierta y la pantalla encendida. Con el móvil bloqueado, el navegador deja de leer el GPS y no se mandan los pings. La app pide al móvil que no apague la pantalla, pero algunos navegadores no lo permiten.

## Puesta en marcha

### 1. Crear la base de datos en Firebase (gratis)

1. Entra en <https://console.firebase.google.com> con tu cuenta de Google y pulsa **Crear un proyecto**. Ponle un nombre (por ejemplo `mi-manhunt`). Google Analytics no hace falta.
2. En el menú de la izquierda: **Compilación → Realtime Database → Crear base de datos**. Elige la ubicación más cercana (por ejemplo Bélgica) y **modo bloqueado**.
3. En la pestaña **Reglas** de la base de datos, borra lo que haya, pega el contenido del archivo `database.rules.json` y pulsa **Publicar**.
4. En el menú: **Compilación → Authentication → Comenzar**. En **Método de acceso**, activa **Anónimo** y guarda.
5. Ve a la rueda ⚙️ → **Configuración del proyecto**. Abajo, en **Tus apps**, pulsa el icono web `</>`, ponle un nombre y regístrala (sin Hosting).
6. Te enseñará un bloque `const firebaseConfig = { ... }`. Copia lo que hay entre las llaves y pégalo en `firebase-config.js`, sustituyendo `null` (hay un ejemplo en el propio archivo).

Esos datos de configuración no son secretos: se pueden subir a un repositorio público. Lo que protege la base de datos son las reglas del paso 3.

### 2. Publicarla en GitHub Pages

1. Crea un repositorio nuevo en <https://github.com/new> (por ejemplo `manhunt`), público.
2. Pulsa **Add file → Upload files** y arrastra todos los archivos de la carpeta `manhunt-app` (son nueve). Pulsa **Commit changes**.
3. Ve a **Settings → Pages**. En **Source** elige **Deploy from a branch**, rama `main` y carpeta `/ (root)`. Guarda.
4. En uno o dos minutos la web estará en `https://TU-USUARIO.github.io/manhunt/`. Ese es el enlace que abrís todos.

GitHub Pages usa HTTPS, que es obligatorio para que el navegador deje usar el GPS.

Al subir los archivos incluye también `manifest.webmanifest`, `sw.js`, `icon-192.png` e `icon-512.png`, que son los que permiten instalarla como app.

### 3. Instalarla en el móvil como una app

No hace falta ninguna tienda de apps. Cada jugador abre el enlace de GitHub Pages en el móvil y:

- **Android (Chrome):** en la pantalla de inicio de la app sale el botón **Instalar app**. Si no sale, abre el menú ⋮ y pulsa **Instalar aplicación** (o **Añadir a pantalla de inicio**).
- **iPhone (Safari):** pulsa el botón **Compartir** (el cuadrado con la flecha) y luego **Añadir a pantalla de inicio**. Tiene que ser desde Safari, no desde Chrome.

Queda un icono en el móvil y se abre a pantalla completa, sin barra del navegador. Cuando subes cambios a GitHub, la app se actualiza sola la próxima vez que se abre con conexión.

Instalada sigue funcionando por dentro como una web. Por eso tiene la misma limitación: con el móvil bloqueado no se mandan pings.

## Modo prueba

Si `firebase-config.js` sigue con `null`, la app funciona igual pero solo entre pestañas del mismo navegador. Sirve para probarla en el ordenador antes de configurar Firebase: abre dos pestañas, crea la partida en una y únete en la otra con el código.

## Privacidad

Las ubicaciones se guardan en tu base de datos de Firebase dentro de la partida. Solo las puede leer quien tenga el código. Al empezar una ronda nueva se borran las ubicaciones de la anterior.
