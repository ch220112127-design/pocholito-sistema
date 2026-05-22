# Sistema de Seguridad Institucional — Pocholito

Dashboard de vigilancia en tiempo real con detección de rostros y placas vehiculares usando YOLOv8, Node.js y MySQL desplegado en Railway.

> **Para el equipo:** Este documento cubre todo lo que necesitan para correr, modificar y administrar el sistema. Las credenciales de Railway y del dashboard les serán enviadas por separado (WhatsApp / mensaje directo).

---

## Tabla de contenidos

1. [Arquitectura del sistema](#1-arquitectura-del-sistema)
2. [Requisitos previos](#2-requisitos-previos)
3. [Configurar el servidor Node.js (local)](#3-configurar-el-servidor-nodejs-local)
4. [Configurar el detector Python (IA)](#4-configurar-el-detector-python-ia)
5. [Configurar la cámara IP](#5-configurar-la-cámara-ip)
6. [Ejecutar todo el sistema](#6-ejecutar-todo-el-sistema)
7. [Estructura del proyecto](#7-estructura-del-proyecto)
8. [Endpoints de la API](#8-endpoints-de-la-api)
9. [Acceder a Railway (servidor en la nube)](#9-acceder-a-railway-servidor-en-la-nube)
10. [Ver y editar la base de datos en Railway](#10-ver-y-editar-la-base-de-datos-en-railway)
11. [Conectar con cliente MySQL externo](#11-conectar-con-cliente-mysql-externo)
12. [Hacer cambios y redesplegar en Railway](#12-hacer-cambios-y-redesplegar-en-railway)
13. [Credenciales y variables de entorno](#13-credenciales-y-variables-de-entorno)
14. [Funciones del Dashboard](#14-funciones-del-dashboard)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Arquitectura del sistema

```
[ Cámara IP (celular) ]
        │ stream MJPEG (HTTP)
        ▼
[ Python / YOLOv8 ]  ──  detecta rostros y placas
        │ POST /conteo  (HTTP)
        ▼
[ Node.js + Express ]  ──  servidor REST + Socket.io
        │                            │
        ▼                            ▼
[ MySQL en Railway ]       [ Dashboard web (browser) ]
  (BD en la nube)          actualiza en tiempo real via WS
```

**Flujo resumido:**
1. Python lee el video del celular cuadro a cuadro.
2. YOLOv8 rastrea objetos (rostros o placas).
3. Cuando un objeto cruza la línea de conteo → guarda foto + manda datos al servidor.
4. Node.js registra en MySQL y emite evento Socket.io.
5. El dashboard se actualiza solo en el navegador.

---

## 2. Requisitos previos

| Herramienta | Versión mínima | Descarga |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| Python | 3.9+ | https://python.org |
| Git | cualquiera | https://git-scm.com |

**Python — librerías necesarias:**
```
ultralytics   opencv-python   requests
```

---

## 3. Configurar el servidor Node.js (local)

```bash
cd api-conteo
npm install
```

Crea el archivo `.env` dentro de `api-conteo/` (copia de `.env.example`):

```bash
# Windows
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Abre `.env` y llena con los datos de Railway (ver sección 13):

```env
MYSQLHOST=tu_host_de_railway
MYSQLPORT=tu_puerto_de_railway
MYSQLUSER=root
MYSQLPASSWORD=tu_password_de_railway
MYSQLDATABASE=railway
PORT=3000
```

Inicia el servidor:

```bash
node server.js
```

Abre `http://localhost:3000` en tu navegador.

---

## 4. Configurar el detector Python (IA)

```bash
cd "Vision ML/Rostros"
pip install ultralytics opencv-python requests
```

**Modelos YOLOv8 necesarios** (deben estar en `Vision ML/Rostros/`):

| Archivo | Para qué sirve |
|---|---|
| `yolov8n-placas.pt` | Detección de placas vehiculares |
| `yolov8n-face.pt` | Detección de rostros |

Si falta `yolov8n-face.pt`, descárgalo de:
https://github.com/akanametov/yolov8-face/releases

---

## 5. Configurar la cámara IP

Instala **IP Webcam** en el celular Android (gratis en Play Store).

1. Abre la app → toca **"Start server"**
2. Anota la IP que aparece en pantalla (ej: `192.168.X.X:8080`)
3. Abre `Vision ML/Rostros/Rostrospro.py` y cambia la línea 15:

```python
FUENTE_VIDEO = "http://TU_IP_AQUI:8080/video"
```

4. Si usas el servidor en Railway (no local), la línea 11 ya tiene la URL correcta:

```python
IP_SERVIDOR = "pocholito-sistema-production.up.railway.app"
```

Si quieres probar en local, cámbiala a:

```python
IP_SERVIDOR = "localhost:3000"
API_URL = f"http://{IP_SERVIDOR}/conteo"
```

---

## 6. Ejecutar todo el sistema

Necesitas **2 terminales** abiertas al mismo tiempo:

**Terminal 1 — Servidor Node.js:**
```bash
cd api-conteo
node server.js
```

Deberías ver:
```
KERNEL ACTIVO · Puerto 3000
DB lista.
Sistema listo.
```

**Terminal 2 — Detector Python:**
```bash
cd "Vision ML/Rostros"
python Rostrospro.py
```

Selecciona modo:
- `1` → Detección de **Rostros**
- `2` → Detección de **Placas**

Presiona `Q` en la ventana de video para apagar.

---

## 7. Estructura del proyecto

```
Pocholito/
├── api-conteo/
│   ├── server.js              # Servidor Express + Socket.io + MySQL
│   ├── public/
│   │   └── index.html         # Dashboard web (HTML+CSS+JS, todo en un archivo)
│   ├── .env.example           # Plantilla de variables de entorno
│   ├── .env                   # Tu copia local (NO subir a git)
│   ├── railway.toml           # Config de deploy automático en Railway
│   └── package.json           # Dependencias Node.js
├── Vision ML/
│   └── Rostros/
│       ├── Rostrospro.py      # Detector principal (rostros + placas)
│       ├── yolov8n-placas.pt  # Modelo IA para placas
│       └── yolov8n-face.pt    # Modelo IA para rostros
└── capturas_institucionales/  # Fotos guardadas automáticamente por Python
```

---

## 8. Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor y BD |
| GET | `/stats` | Conteo por categoría |
| POST | `/conteo` | Registrar nueva detección |
| GET | `/registros` | Listar registros (con filtros) |
| PUT | `/marcar-conocido/:id` | Asignar nombre/datos a una detección |
| POST | `/registrar-rostro` | Agregar rostro conocido manualmente |
| POST | `/registrar-placa` | Agregar placa conocida manualmente |
| GET | `/conocidos/rostros` | Listar rostros conocidos |
| GET | `/conocidos/placas` | Listar placas conocidas |
| DELETE | `/conocidos/rostro/:id` | Eliminar rostro conocido |
| DELETE | `/conocidos/placa/:id` | Eliminar placa conocida |
| GET | `/fotos/:nombre` | Servir foto capturada |

---

## 9. Acceder a Railway (servidor en la nube)

Railway es donde vive el servidor Node.js y la base de datos MySQL. Para entrar:

### Paso 1 — Crear cuenta o hacer login

1. Ve a **https://railway.app**
2. Si ya tienes cuenta: clic en **Login**
3. Si te comparten acceso: el dueño del proyecto te envía una invitación por correo electrónico desde Railway
   - Revisa tu bandeja de entrada
   - Acepta la invitación → te pedirá crear o vincular tu cuenta GitHub

### Paso 2 — Abrir el proyecto

1. Una vez dentro del dashboard de Railway, verás una lista de proyectos
2. Busca el proyecto llamado **"pocholito-sistema"** (o similar)
3. Clic en él para abrirlo

### Paso 3 — Entender la vista del proyecto

Dentro verás dos servicios (bloques):

```
┌─────────────────────┐   ┌─────────────────────┐
│   api-conteo        │   │   MySQL             │
│   (Node.js server)  │   │   (base de datos)   │
└─────────────────────┘   └─────────────────────┘
```

- **api-conteo** → tu servidor Express (el backend)
- **MySQL** → la base de datos en la nube

---

## 10. Ver y editar la base de datos en Railway

### Opción A — Query directo desde Railway (más fácil)

1. En el dashboard del proyecto, clic en el servicio **MySQL**
2. Ve a la pestaña **"Data"** (o "Query")
3. Verás un editor SQL donde puedes escribir consultas directamente

Consultas útiles:

```sql
-- Ver todos los registros de conteo
SELECT * FROM conteo_peatonal ORDER BY fecha_hora DESC LIMIT 50;

-- Contar por categoría
SELECT categoria, COUNT(*) as total FROM conteo_peatonal GROUP BY categoria;

-- Ver rostros conocidos
SELECT * FROM rostros_conocidos;

-- Ver placas conocidas
SELECT * FROM placas_conocidas;

-- Borrar todos los registros de conteo (CUIDADO)
DELETE FROM conteo_peatonal;

-- Borrar un registro específico por ID
DELETE FROM conteo_peatonal WHERE id = 5;
```

### Opción B — Ver las variables de conexión

1. Clic en el servicio **MySQL**
2. Pestaña **"Variables"**
3. Verás algo como:

```
MYSQLHOST      = containers-us-west-XXX.railway.app
MYSQLPORT      = 6543
MYSQLUSER      = root
MYSQLPASSWORD  = xxxxxxxxxxxxxxxxxxxxxxxx
MYSQLDATABASE  = railway
MYSQL_URL      = mysql://root:xxxx@containers...railway.app:6543/railway
```

Esos valores son los que van en tu archivo `.env` local.

### Ver logs del servidor Node.js

1. Clic en el servicio **api-conteo**
2. Pestaña **"Logs"**
3. Verás en tiempo real todo lo que imprime el servidor (conexiones, errores, detecciones)

---

## 11. Conectar con cliente MySQL externo

Si quieres ver la BD con una herramienta visual (recomendado para editar datos fácil):

**Herramientas recomendadas (gratis):**
- **TablePlus** — https://tableplus.com (más cómodo, Mac/Windows)
- **DBeaver** — https://dbeaver.io (Windows/Mac/Linux, 100% gratis)
- **MySQL Workbench** — https://dev.mysql.com/downloads/workbench/

### Configurar la conexión (datos de la pestaña Variables de Railway):

| Campo | Valor |
|---|---|
| Host | valor de `MYSQLHOST` |
| Port | valor de `MYSQLPORT` |
| User | `root` |
| Password | valor de `MYSQLPASSWORD` |
| Database | `railway` |
| SSL | **Activado / Required** |

> **IMPORTANTE:** Railway requiere SSL. En TablePlus activa "SSL" en la configuración. En DBeaver ve a "Driver properties" → `useSSL=true`, `requireSSL=true`.

---

## 12. Hacer cambios y redesplegar en Railway

El servidor en Railway se actualiza automáticamente cuando haces push al repositorio de GitHub.

**Repositorio:** https://github.com/ch220112127-design/pocholito-sistema

Railway está vinculado a este repo — cada push a `main` redespliega el servidor automáticamente (~1-2 min).

### Clonar el repo (primer paso para nuevos integrantes):

```bash
git clone https://github.com/ch220112127-design/pocholito-sistema.git
cd pocholito-sistema
```

### Subir cambios:

```bash
git add .
git commit -m "descripción del cambio"
git push origin main
```

Railway detecta el push y redespliega solo (tarda ~1-2 min).

### Si no tienes Git configurado, usa Railway CLI:

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Dentro de la carpeta api-conteo, vincular al proyecto
cd api-conteo
railway link

# Subir cambios
railway up
```

### Verificar que el deploy funcionó:

1. Railway → proyecto → servicio api-conteo → pestaña **"Deployments"**
2. Debe aparecer un deployment nuevo con estado **"Success"** (checkmark verde)
3. Prueba el endpoint: `https://pocholito-sistema-production.up.railway.app/health`
   - Respuesta esperada: `{"status":"ok","db":true,"uptime":123}`

---

## 13. Credenciales y variables de entorno

> **Las credenciales reales serán compartidas por el dueño del proyecto vía mensaje directo.**
> No las compartas en chats públicos ni las subas a GitHub.

### Variables para tu `.env` local:

```env
# Llenar con los datos que te comparta el dueño del proyecto
MYSQLHOST=
MYSQLPORT=
MYSQLUSER=root
MYSQLPASSWORD=
MYSQLDATABASE=railway
PORT=3000
```

### Credenciales del Dashboard web:

| Campo | Valor |
|---|---|
| URL (Railway) | `https://pocholito-sistema-production.up.railway.app` |
| URL (local) | `http://localhost:3000` |
| Usuario | `admin` |
| Contraseña | *(te la comparte el dueño)* |

> Nota técnica: estas credenciales están validadas en el cliente (JavaScript del dashboard). No son autenticación de servidor. Para producción real se implementaría JWT o sesiones en el backend.

### Cuenta de Railway:

| Campo | Valor |
|---|---|
| Email | ch220112127@chapala.tecmm.edu.mx |
| Contraseña | *(te la comparte el dueño directamente)* |

---

## 14. Funciones del Dashboard

| Función | Descripción |
|---|---|
| **Capturas recientes** | Últimas 6 fotos detectadas con info de ID y categoría |
| **Estadísticas** | Conteo de Rostro Conocido / Desconocido / Placa Conocida / Desconocida |
| **Registrar persona** | Asigna nombre + vehículo a un rostro desconocido |
| **Asignar a existente** | Si ya existe "Juan", asigna la nueva detección al mismo registro |
| **Registrar placa** | Guarda número de placa + tipo de carro + propietario |
| **Panel Admin** | Agrega o elimina personas y placas conocidas manualmente |
| **Exportar CSV** | Descarga reporte con los filtros activos |
| **Filtros** | Filtra por cámara, categoría, rango de fecha y hora |
| **Log en vivo** | Terminal en el dashboard que muestra detecciones en tiempo real |

---

## 15. Troubleshooting

### El servidor no conecta a la BD

Verifica que las variables de entorno en `.env` sean exactamente las de Railway. Prueba:
```bash
node -e "require('dotenv').config(); console.log(process.env.MYSQLHOST)"
```
Debe mostrar el host de Railway, no `undefined`.

### Python no conecta a la cámara

- Verifica que el celular y la PC estén en el **mismo WiFi**
- Revisa la IP en `Rostrospro.py` línea 15 — debe coincidir con lo que muestra la app IP Webcam
- Prueba la URL en el navegador: `http://TU_IP:8080/video`

### No detecta rostros / placas

- Verifica que `yolov8n-face.pt` o `yolov8n-placas.pt` existan en `Vision ML/Rostros/`
- Sube la cámara más cerca del objeto
- El umbral de confianza es `conf=0.50` en `Rostrospro.py` línea 140 — bájalo a `0.35` si no detecta

### Railway muestra error en Deployments

1. Clic en el deployment fallido → ver logs de build
2. Errores comunes:
   - `Cannot find module` → falta `npm install` (no debería pasar con `package.json` correcto)
   - `ECONNREFUSED` al iniciar → variables de MySQL no configuradas en Railway Variables
3. Solución: Railway → servicio api-conteo → pestaña **Variables** → verificar que estén las variables de MySQL

### El dashboard no actualiza en tiempo real

- Socket.io requiere que el servidor esté corriendo
- Verifica en la consola del navegador (F12) que no haya errores de conexión WebSocket
- Si usas Railway, la URL del servidor debe ser la de Railway, no localhost

### Cómo reiniciar el servidor en Railway

1. Railway → proyecto → servicio api-conteo
2. Clic en los tres puntos (⋯) → **"Restart"**

---

## Resumen rápido para empezar

```bash
# 1. Instalar dependencias
cd api-conteo && npm install

# 2. Crear .env con datos de Railway (pedírselos al dueño)
copy .env.example .env
# editar .env con los datos reales

# 3. Instalar Python deps
cd "../Vision ML/Rostros"
pip install ultralytics opencv-python requests

# 4. Correr el servidor
cd ../../api-conteo
node server.js

# 5. En otra terminal, correr el detector
cd "../Vision ML/Rostros"
python Rostrospro.py
```

Abrir navegador en `http://localhost:3000`
