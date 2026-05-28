//! Offscreen wgpu viewport for Trivor (极视), composited into Slint as RGBA.

use glam::{Mat4, Vec3};
use trivor_core::{BoundingBox, DrawBatch, LoadedScene, TextureImage};
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("shader.wgsl");

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniform {
    view_proj: [[f32; 4]; 4],
}

struct SceneGpu {
    batches: Vec<DrawBatch>,
    batch_bind_groups: Vec<wgpu::BindGroup>,
    _textures: Vec<wgpu::Texture>,
}

struct GpuState {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    material_bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    vertex_buffer: Option<wgpu::Buffer>,
    index_buffer: Option<wgpu::Buffer>,
    scene_gpu: Option<SceneGpu>,
    target: wgpu::Texture,
    view: wgpu::TextureView,
    /// Kept alive for the lifetime of `depth_view`.
    _depth: wgpu::Texture,
    depth_view: wgpu::TextureView,
    readback: wgpu::Buffer,
    width: u32,
    height: u32,
}

/// RGBA8 pixels for Slint `Image::from_rgba8`.
#[derive(Clone)]
pub struct FramePixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct ViewportRenderer {
    gpu: Option<GpuState>,
    scene: Option<LoadedScene>,
    pending_upload: bool,
    camera: OrbitCamera,
    pixels: FramePixels,
    needs_redraw: bool,
}

struct OrbitCamera {
    target: Vec3,
    distance: f32,
    yaw: f32,
    pitch: f32,
}

impl OrbitCamera {
    fn fit_bounds(bounds: &BoundingBox) -> Self {
        let center = (bounds.min + bounds.max) * 0.5;
        let radius = bounds.size().length().max(0.001) * 0.5;
        let extent = bounds.size();
        let dist = radius * 2.4;
        Self {
            target: center,
            distance: dist.max(extent.y.max(extent.x) * 1.8),
            yaw: 0.72,
            pitch: 0.28,
        }
    }

    fn view_proj(&self, aspect: f32) -> Mat4 {
        let eye = self.target
            + Vec3::new(
                self.distance * self.yaw.cos() * self.pitch.cos(),
                self.distance * self.pitch.sin(),
                self.distance * self.yaw.sin() * self.pitch.cos(),
            );
        let view = Mat4::look_at_rh(eye, self.target, Vec3::Y);
        let proj =
            Mat4::perspective_rh(45f32.to_radians(), aspect.max(0.1), 0.01, self.distance * 50.0);
        proj * view
    }
}

impl Default for ViewportRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewportRenderer {
    pub fn new() -> Self {
        Self {
            gpu: None,
            scene: None,
            camera: OrbitCamera {
                target: Vec3::ZERO,
                distance: 3.0,
                yaw: 0.65,
                pitch: 0.38,
            },
            pixels: FramePixels {
                width: 0,
                height: 0,
                rgba: Vec::new(),
            },
            needs_redraw: true,
            pending_upload: false,
        }
    }

    pub fn init(&mut self) {
        tracing::debug!("viewport renderer ready (wgpu offscreen)");
    }

    pub fn has_scene(&self) -> bool {
        self.scene.is_some()
    }

    pub fn scene(&self) -> Option<&LoadedScene> {
        self.scene.as_ref()
    }

    pub fn set_scene(&mut self, scene: LoadedScene) {
        tracing::info!(
            path = %scene.source_path,
            triangles = scene.stats.triangle_count,
            "viewport scene loaded"
        );
        self.camera = OrbitCamera::fit_bounds(&scene.bounds);
        self.scene = Some(scene);
        self.needs_redraw = true;
        self.pending_upload = true;
        if let (Some(gpu), Some(scene)) = (self.gpu.as_mut(), self.scene.as_ref()) {
            upload_scene(gpu, scene);
            self.pending_upload = false;
        }
    }

    pub fn clear_scene(&mut self) {
        self.scene = None;
        self.needs_redraw = true;
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.scene_gpu = None;
            gpu.vertex_buffer = None;
            gpu.index_buffer = None;
        }
    }

    pub fn mark_dirty(&mut self) {
        self.needs_redraw = true;
    }

    /// Render into an RGBA buffer for Slint. Returns cached image if size unchanged and not dirty.
    pub fn render_frame(&mut self, width: u32, height: u32) -> Option<&FramePixels> {
        if width < 8 || height < 8 {
            return None;
        }
        if self.scene.is_none() {
            return None;
        }

        let size_changed = self.pixels.width != width
            || self.pixels.height != height
            || self.gpu.as_ref().is_none_or(|g| g.width != width || g.height != height);

        if size_changed {
            self.gpu = Some(pollster::block_on(create_gpu(width, height)));
            self.pending_upload = true;
        }

        if self.pending_upload {
            if let (Some(gpu), Some(scene)) = (self.gpu.as_mut(), self.scene.as_ref()) {
                upload_scene(gpu, scene);
                self.pending_upload = false;
            }
        }

        if !self.needs_redraw && !size_changed && !self.pixels.rgba.is_empty() {
            return Some(&self.pixels);
        }

        let gpu = self.gpu.as_mut()?;
        let aspect = width as f32 / height as f32;
        let view_proj = self.camera.view_proj(aspect);
        let uniform = CameraUniform {
            view_proj: view_proj.to_cols_array_2d(),
        };
        gpu.queue
            .write_buffer(&gpu.camera_buffer, 0, bytemuck::bytes_of(&uniform));

        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("trivor viewport"),
            });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("trivor pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &gpu.view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.05,
                            g: 0.05,
                            b: 0.06,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &gpu.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&gpu.pipeline);
            pass.set_bind_group(0, &gpu.camera_bind_group, &[]);
            if let (Some(vb), Some(ib), Some(scene_gpu)) =
                (&gpu.vertex_buffer, &gpu.index_buffer, &gpu.scene_gpu)
            {
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                for (batch, bind_group) in scene_gpu
                    .batches
                    .iter()
                    .zip(scene_gpu.batch_bind_groups.iter())
                {
                    if batch.index_count == 0 {
                        continue;
                    }
                    pass.set_bind_group(1, bind_group, &[]);
                    let end = batch.index_start + batch.index_count;
                    pass.draw_indexed(batch.index_start..end, 0, 0..1);
                }
            } else {
                tracing::warn!("viewport draw skipped: scene GPU data missing");
            }
        }

        let bytes_per_row = width * 4;
        let padded = align_to(bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &gpu.target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &gpu.readback,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        gpu.queue.submit(Some(encoder.finish()));

        let slice = gpu.readback.slice(..);
        let (send, recv) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            send.send(r).ok();
        });
        loop {
            gpu.device.poll(wgpu::Maintain::Wait);
            match recv.try_recv() {
                Ok(Ok(())) => break,
                Ok(Err(e)) => {
                    tracing::warn!(?e, "viewport GPU map_async failed");
                    return None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => continue,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    tracing::warn!("viewport GPU readback channel closed");
                    return None;
                }
            }
        }

        let data = slice.get_mapped_range();
        self.pixels.width = width;
        self.pixels.height = height;
        self.pixels.rgba.resize((width * height * 4) as usize, 0);
        for y in 0..height as usize {
            let src = y * padded as usize;
            let dst = y * bytes_per_row as usize;
            self.pixels.rgba[dst..dst + bytes_per_row as usize]
                .copy_from_slice(&data[src..src + bytes_per_row as usize]);
        }
        drop(data);
        gpu.readback.unmap();

        self.needs_redraw = false;
        Some(&self.pixels)
    }

    pub fn orbit(&mut self, delta_yaw: f32, delta_pitch: f32) {
        self.camera.yaw += delta_yaw;
        self.camera.pitch = (self.camera.pitch + delta_pitch).clamp(-1.4, 1.4);
        self.needs_redraw = true;
    }

    pub fn zoom(&mut self, factor: f32) {
        self.camera.distance = (self.camera.distance * factor).clamp(0.05, 10_000.0);
        self.needs_redraw = true;
    }

    pub fn fit_current(&mut self) {
        if let Some(scene) = self.scene.as_ref() {
            self.camera = OrbitCamera::fit_bounds(&scene.bounds);
            self.needs_redraw = true;
        }
    }
}

fn align_to(v: u32, align: u32) -> u32 {
    (v + align - 1) / align * align
}

async fn create_gpu(width: u32, height: u32) -> GpuState {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        ..Default::default()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .expect("no wgpu adapter");

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("trivor device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
        .await
        .expect("wgpu device");

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("trivor shader"),
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });

    let camera_bind_group_layout =
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("camera layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

    let material_bind_group_layout =
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("material layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("material sampler"),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::FilterMode::Nearest,
        ..Default::default()
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("trivor pipeline layout"),
        bind_group_layouts: &[&camera_bind_group_layout, &material_bind_group_layout],
        push_constant_ranges: &[],
    });

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("trivor pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: "vs_main",
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: 48,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                    wgpu::VertexAttribute {
                        offset: 0,
                        shader_location: 0,
                        format: wgpu::VertexFormat::Float32x3,
                    },
                    wgpu::VertexAttribute {
                        offset: 12,
                        shader_location: 1,
                        format: wgpu::VertexFormat::Float32x3,
                    },
                    wgpu::VertexAttribute {
                        offset: 24,
                        shader_location: 2,
                        format: wgpu::VertexFormat::Float32x2,
                    },
                    wgpu::VertexAttribute {
                        offset: 32,
                        shader_location: 3,
                        format: wgpu::VertexFormat::Float32x4,
                    },
                ],
            }],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: "fs_main",
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState {
            cull_mode: None,
            front_face: wgpu::FrontFace::Ccw,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: true,
            depth_compare: wgpu::CompareFunction::Less,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("camera"),
        size: std::mem::size_of::<CameraUniform>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("camera bind"),
        layout: &camera_bind_group_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: camera_buffer.as_entire_binding(),
        }],
    });

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("viewport color"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());

    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("viewport depth"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let depth_view = depth.create_view(&Default::default());

    let bytes_per_row = align_to(width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: (bytes_per_row * height) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    GpuState {
        device,
        queue,
        pipeline,
        camera_buffer,
        camera_bind_group,
        material_bind_group_layout,
        sampler,
        vertex_buffer: None,
        index_buffer: None,
        scene_gpu: None,
        target,
        view,
        _depth: depth,
        depth_view,
        readback,
        width,
        height,
    }
}

impl ViewportRenderer {
    /// Render once and return owned pixels (for immediate UI update after load).
    pub fn render_frame_owned(&mut self, width: u32, height: u32) -> Option<FramePixels> {
        self.render_frame(width, height).cloned()
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuVertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
    color: [f32; 4],
}

fn upload_scene(gpu: &mut GpuState, scene: &LoadedScene) {
    let mesh = &scene.cpu_mesh;
    if mesh.is_empty() {
        return;
    }
    let default_color = [1.0_f32, 1.0, 1.0, 1.0];
    let vertices: Vec<GpuVertex> = mesh
        .positions
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let n = mesh.normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
            let uv = mesh.uvs.get(i).copied().unwrap_or([0.0, 0.0]);
            let c = mesh.colors.get(i).copied().unwrap_or(default_color);
            GpuVertex {
                position: *p,
                normal: n,
                uv,
                color: c,
            }
        })
        .collect();

    gpu.vertex_buffer = Some(
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh vertices"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            }),
    );
    gpu.index_buffer = Some(
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh indices"),
                contents: bytemuck::cast_slice(&mesh.indices),
                usage: wgpu::BufferUsages::INDEX,
            }),
    );

    let mut kept_textures: Vec<wgpu::Texture> = Vec::new();
    let mut texture_views: Vec<wgpu::TextureView> = Vec::new();

    for tex in &scene.textures {
        let (texture, view) = create_texture_from_rgba(&gpu.device, &gpu.queue, tex);
        kept_textures.push(texture);
        texture_views.push(view);
    }

    let (white_texture, white_view) = create_texture_from_rgba(
        &gpu.device,
        &gpu.queue,
        &TextureImage {
            width: 1,
            height: 1,
            rgba: vec![255, 255, 255, 255],
        },
    );
    let white_index = texture_views.len();
    kept_textures.push(white_texture);
    texture_views.push(white_view);

    let mut batch_bind_groups = Vec::with_capacity(scene.draw_batches.len());
    for batch in &scene.draw_batches {
        let view = batch
            .texture_index
            .and_then(|ti| texture_views.get(ti))
            .unwrap_or_else(|| texture_views.get(white_index).expect("white view"));
        batch_bind_groups.push(gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("batch material"),
            layout: &gpu.material_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&gpu.sampler),
                },
            ],
        }));
    }

    gpu.scene_gpu = Some(SceneGpu {
        batches: scene.draw_batches.clone(),
        batch_bind_groups,
        _textures: kept_textures,
    });
}

fn create_texture_from_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    image: &TextureImage,
) -> (wgpu::Texture, wgpu::TextureView) {
    let width = image.width.max(1);
    let height = image.height.max(1);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("material tex"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &image.rgba,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(4 * width),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    (texture, view)
}
