#!/usr/bin/env ruby
#
# Generate a lightweight content index for Graph View (Quartz-like).

require 'json'
require 'fileutils'
require 'set'

module Jekyll
  class GraphIndexFile < StaticFile
    def initialize(site, index)
      @site = site
      @index = index
      dir = File.join('assets', 'graph')
      name = 'content-index.json'
      super(site, site.source, dir, name)
    end

    def write(dest)
      path = destination(dest)
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, JSON.pretty_generate(@index))
      true
    end
  end

  class GraphIndexGenerator < Generator
    safe true
    priority :lowest

    MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/.freeze
    WIKILINK = /\[\[([^\]]+)\]\]/.freeze

    def generate(site)
      cfg = site.config.fetch('graph', {})
      return unless cfg.fetch('enabled', true)

      index = build_index(site, cfg)
      site.static_files << GraphIndexFile.new(site, index)
    end

    private

    def build_index(site, cfg)
      nodes = collect_nodes(site, cfg)
      known_full = nodes.keys.to_set

      out = {}
      nodes.each do |full_slug, doc|
        out[full_slug] = {
          'slug' => full_slug,
          'title' => (doc.data['title'] || full_slug),
          'tags' => Array(doc.data['tags']).map(&:to_s),
          'links' => extract_links(doc, full_slug, known_full, site)
        }
      end

      out
    end

    def collect_nodes(site, cfg)
      include_pages = cfg.fetch('include_pages', true)
      include_posts = cfg.fetch('include_posts', true)
      include_tabs = cfg.fetch('include_tabs', true)
      posts_only = cfg.fetch('posts_only', false)
      required_tag = cfg.fetch('required_tag', nil)
      exclude_paths = Array(cfg.fetch('exclude_paths', [])).map(&:to_s)

      nodes = {}

      if include_pages
        site.pages.each { |p| add_doc(site, cfg, nodes, p, exclude_paths) } unless posts_only
      end

      if include_posts && site.respond_to?(:posts) && site.posts.respond_to?(:docs)
        site.posts.docs.each { |p| add_doc(site, cfg, nodes, p, exclude_paths) }
      end

      if include_tabs && site.collections.key?('tabs')
        site.collections['tabs'].docs.each { |p| add_doc(site, cfg, nodes, p, exclude_paths) } unless posts_only
      end

      nodes
    end

    def add_doc(site, cfg, nodes, doc, exclude_paths)
      return unless doc.respond_to?(:url) && doc.url
      return unless doc.data.is_a?(Hash)
      return if doc.data['sitemap'] == false
      return if doc.data['graph'] == false

      posts_only = cfg.fetch('posts_only', false)
      if posts_only
        return unless doc.respond_to?(:collection) && doc.collection && doc.collection.label == 'posts'
      end

      required_tag = cfg.fetch('required_tag', nil)
      if required_tag && !required_tag.to_s.strip.empty?
        tags = Array(doc.data['tags']).map(&:to_s)
        return unless tags.include?(required_tag.to_s)
      end

      path = doc.path.to_s
      return if exclude_paths.any? { |prefix| path.start_with?(prefix) }

      full_slug = url_to_full_slug(doc.url.to_s, site_baseurl: site.config['baseurl'].to_s)
      return if full_slug.nil? || full_slug.empty?

      nodes[full_slug] = doc
    end

    def extract_links(doc, source_full_slug, known_full, site)
      raw = doc.respond_to?(:content) ? doc.content.to_s : ''
      links = Set.new

      raw.scan(MARKDOWN_LINK).each do |m|
        dest_full = normalize_href_to_full_slug(m.first, source_full_slug, site)
        next unless dest_full && known_full.include?(dest_full)
        links.add(full_to_simple_slug(dest_full))
      end

      raw.scan(WIKILINK).each do |m|
        dest_full = wikilink_to_full_slug(m.first)
        next unless dest_full && known_full.include?(dest_full)
        links.add(full_to_simple_slug(dest_full))
      end

      links.to_a.sort
    end

    def normalize_href_to_full_slug(href, source_full_slug, site)
      return nil if href.nil?
      href = href.to_s.strip
      return nil if href.empty?
      return nil if href.start_with?('mailto:', 'tel:', 'javascript:')
      return nil if href =~ %r{\A[a-z]+://}i

      href = href.split('#', 2).first
      href = href.split('?', 2).first
      return nil if href.nil? || href.empty?

      if href.start_with?('/')
        # absolute (site-root) link, may include baseurl
        baseurl = site.config['baseurl'].to_s
        href = href.sub(/\A#{Regexp.escape(baseurl)}/, '') unless baseurl.empty?
        return url_to_full_slug(href, site_baseurl: '')
      end

      # relative link
      base_url = full_slug_to_url(source_full_slug)
      base = base_url.end_with?('/') ? base_url : File.dirname(base_url) + '/'
      resolved = url_join(base, href)
      url_to_full_slug(resolved, site_baseurl: '')
    end

    def wikilink_to_full_slug(text)
      t = text.to_s.strip
      return nil if t.empty?
      slug = t.split('|', 2).first.to_s.strip
      slug = slug.gsub(/\s+/, '-')
      # treat wikilinks as /slug/ pages
      url_to_full_slug("/#{slug}/", site_baseurl: '')
    end

    def url_to_full_slug(url, site_baseurl:)
      u = url.to_s.strip.tr('\\', '/')
      return nil if u.empty?

      # remove baseurl prefix if present
      b = site_baseurl.to_s.strip
      u = u.sub(/\A#{Regexp.escape(b)}/, '') unless b.empty?

      u = "/#{u}" unless u.start_with?('/')
      u = u.gsub(%r{//+}, '/')
      u = u.split('#', 2).first
      u = u.split('?', 2).first
      u = u.sub(%r{/index\.html\z}i, '/')

      if u == '/'
        return 'index'
      end

      # Treat extensionless paths as "pretty" permalinks (folders).
      # e.g. "/posts/write-a-new-post" should map to "posts/write-a-new-post/index"
      if !u.end_with?('/')
        last = u.split('/').last.to_s
        has_ext = last.include?('.') # crude but sufficient for our use
        u = u + '/' unless has_ext
      end

      if u.end_with?('/')
        (u.sub(/\A\//, '') + 'index').sub(%r{/\z}, '')
      else
        u.sub(/\A\//, '').sub(%r{/\z}, '')
      end
    end

    def full_slug_to_url(full_slug)
      s = full_slug.to_s
      return '/' if s == 'index'
      if s.end_with?('/index')
        "/#{s.sub(%r{/index\z}, '')}/"
      else
        "/#{s}/"
      end
    end

    def full_to_simple_slug(full_slug)
      s = full_slug.to_s
      return '/' if s == 'index'
      if s.end_with?('/index')
        s.sub(%r{/index\z}, '')
      else
        s
      end
    end

    def url_join(base, rel)
      b = base.to_s.tr('\\', '/')
      r = rel.to_s.tr('\\', '/')
      joined = b.end_with?('/') ? (b + r) : (b + '/' + r)

      # normalize ./ and ../ segments
      parts = joined.split('/')
      stack = []
      parts.each do |p|
        next if p.empty? || p == '.'
        if p == '..'
          stack.pop
        else
          stack << p
        end
      end
      '/' + stack.join('/')
    end
  end
end
